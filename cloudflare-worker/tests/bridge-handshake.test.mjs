// ============================================================
// Gemini Web-Bridge: /bridge WebSocket handshake regression tests
//
// Guards the P0 outage where the DO called the Node-only
// `crypto.createHash()` while building the connection id:
//
//   TypeError: crypto.createHash is not a function   (workerd, every upgrade)
//   → client saw "Error during WebSocket handshake: Unexpected response code: 409"
//     (or HTTP 500) and "Bridge extension offline", because the throw happened
//     AFTER recordConnection(), leaving a 45s "healthy" zombie entry that
//     rejected every other instance with 409 Conflict.
//
// The VM context below deliberately exposes a WebCrypto-only `crypto` object
// (exactly like the Workers runtime) instead of Node's global crypto, which
// also carries createHash/createHmac/Cipheriv and therefore used to hide this
// class of bug from `npm test`.
//
// Run: node --test tests/bridge-handshake.test.mjs
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import * as modelCatalog from '../src/model-catalog.js';

// ─── Load DO source and strip Cloudflare imports ───────────────
const doSource = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

const doClassSrc = doSource
  .replace(/import[\s\S]*?from "[^"]+";/g, '')
  .replaceAll('export class ', 'class ')
  .replace('export default {', 'const entry = {');

// ─── Workerd-accurate globals ──────────────────────────────────
// Workers expose WebCrypto (randomUUID / getRandomValues / subtle) on the
// global crypto object. Node-only helpers must NOT be reachable here.
const workerdCrypto = {
  randomUUID,
  getRandomValues: (arr) => globalThis.crypto.getRandomValues(arr),
  subtle: globalThis.crypto.subtle,
};

assert.equal(
  typeof workerdCrypto.createHash, 'undefined',
  'test harness must not leak Node-only crypto APIs into the DO context'
);

// Minimal WebSocketPair double: accept/addEventListener/send/close.
class MockSocket {
  constructor() {
    this.readyState = 1;
    this.accepted = false;
    this.sent = [];
    this.closed = null;
    this.listeners = new Map();
  }
  accept() { this.accepted = true; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  send(data) { this.sent.push(data); }
  close(code, reason) { this.readyState = 3; this.closed = { code, reason }; }
  dispatch(type, event) {
    for (const fn of this.listeners.get(type) || []) fn(event);
  }
}

class MockWebSocketPair {
  constructor() {
    this[0] = new MockSocket(); // client
    this[1] = new MockSocket(); // server
  }
}

// Node's Response rejects status 101 ("must be in the range of 200 to 599"),
// so the handshake needs a Response double that accepts the upgrade response.
class MockResponse {
  constructor(body = null, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = init.headers || {};
    this.webSocket = init.webSocket ?? null;
  }
  async text() { return this.body == null ? '' : String(this.body); }
}

class ThrowingResponse extends MockResponse {
  constructor(body = null, init = {}) {
    if (init.status === 101) throw new TypeError('simulated runtime rejection of the 101 response');
    super(body, init);
  }
}

function loadDO({ ResponseImpl = MockResponse } = {}) {
  const context = {
    ...modelCatalog,
    DurableObject: class {},
    crypto: workerdCrypto,
    Response: ResponseImpl,
    Request,
    URL,
    TextEncoder,
    TextDecoder,
    TextEncoderStream,
    TransformStream,
    ReadableStream,
    WebSocketPair: MockWebSocketPair,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => {},
  };
  return vm.runInNewContext(doClassSrc + '\n;({GeminiBridgeDO})', context).GeminiBridgeDO;
}

const GeminiBridgeDO = loadDO();

const BRIDGE_TOKEN = 'bridge-secret-token-2026';
const CLIENT_TOKEN = 'client-bearer-secret-2026';
const INSTANCE_A = '4e2b3729-f87d-43da-8ad4-6f88f1864bce';
const INSTANCE_B = '51a73559-cbb9-44c9-bab2-28de0661c5e5';
const INSTANCE_C = '97ac047d-479c-4ee7-9cb8-902791aae48e';

function createBridge(DOClass = GeminiBridgeDO) {
  return new DOClass({}, { BRIDGE_AUTH_TOKEN: BRIDGE_TOKEN, CLIENT_API_TOKEN: CLIENT_TOKEN });
}

function wsRequest(instanceId, { token = BRIDGE_TOKEN, upgrade = 'websocket' } = {}) {
  const headers = { 'x-bridge-token': token };
  if (upgrade) headers.Upgrade = upgrade;
  if (instanceId) headers['x-instance-id'] = instanceId;
  const qs = instanceId ? `?token=${token}&client=background_sw&instanceId=${instanceId}` : `?token=${token}`;
  return new Request(`https://bridge.test/bridge${qs}`, { method: 'GET', headers });
}

// ═════════════════════════════════════════════════════════════
// 1. Connection id derivation must not depend on Node crypto
// ═════════════════════════════════════════════════════════════

test('1. _connectionId derives a 16-hex id without Node-only crypto APIs', () => {
  const b = createBridge();
  const id = b._connectionId(INSTANCE_A, [new MockSocket(), new MockSocket()]);

  assert.match(id, /^[0-9a-f]{16}$/, 'connId keeps the previous 16-hex-char shape');
  assert.notEqual(
    id,
    b._connectionId(INSTANCE_A, [new MockSocket(), new MockSocket()]),
    'each connection attempt gets a fresh id'
  );
});

// ═════════════════════════════════════════════════════════════
// 2. Happy path: upgrade accepted, connection recorded, health OK
// ═════════════════════════════════════════════════════════════

test('2. /bridge upgrade returns 101 and records exactly one connection', async () => {
  const b = createBridge();
  const res = await b.fetch(wsRequest(INSTANCE_A));

  assert.equal(res.status, 101, 'upgrade must succeed (no crypto.createHash TypeError)');
  assert.ok(res.webSocket, 'client socket handed back to the caller');
  assert.equal(b.activeConnections.size, 1);
  assert.ok(b.activeConnections.has(INSTANCE_A));

  const state = b.activeConnections.get(INSTANCE_A);
  assert.equal(state.epoch, 1);
  assert.equal(state.socket.accepted, true);
});

test('3. SESSION_READY flips /health to CONNECTED_AND_READY for the recorded instance', async () => {
  const b = createBridge();
  await b.fetch(wsRequest(INSTANCE_A));
  const server = b.activeConnections.get(INSTANCE_A).socket;

  server.dispatch('message', {
    data: JSON.stringify({ type: 'SESSION_READY', tokens: { SNlM0e: 'x' }, models: [] }),
  });

  const health = await b.fetch(new Request('https://bridge.test/health'));
  const body = JSON.parse(health.body);

  assert.equal(health.status, 200);
  assert.equal(body.extension_status, 'CONNECTED_AND_READY');
  assert.equal(body.instance_tracking.active_connections_count, 1);
  assert.equal(body.instance_tracking.connections[0].instanceId, INSTANCE_A);
});

// ═════════════════════════════════════════════════════════════
// 3. Conflict / reconnect semantics (the 409 the client reported)
// ═════════════════════════════════════════════════════════════

test('4. Healthy connection from another instanceId is rejected with 409 Conflict', async () => {
  const b = createBridge();
  await b.fetch(wsRequest(INSTANCE_A));

  const res = await b.fetch(wsRequest(INSTANCE_B));

  assert.equal(res.status, 409);
  assert.match(String(res.body), /Conflict/);
  assert.equal(b.activeConnections.size, 1);
  assert.ok(b.activeConnections.has(INSTANCE_A), 'healthy instance keeps the slot');
});

test('5. Same instanceId reconnect replaces the old socket (never 409)', async () => {
  const b = createBridge();
  await b.fetch(wsRequest(INSTANCE_A));
  const firstSocket = b.activeConnections.get(INSTANCE_A).socket;

  const res = await b.fetch(wsRequest(INSTANCE_A));

  assert.equal(res.status, 101);
  assert.equal(firstSocket.closed?.code, 1000, 'previous socket closed as replaced');
  assert.equal(b.activeConnections.size, 1);
  assert.equal(b.activeConnections.get(INSTANCE_A).epoch, 2);
});

test('6. Stale entry (idle > 45s) is evicted so a new instance can take over', async () => {
  const b = createBridge();
  await b.fetch(wsRequest(INSTANCE_A));
  b.activeConnections.get(INSTANCE_A).lastActivityAt = Date.now() - 46_000;

  const res = await b.fetch(wsRequest(INSTANCE_B));

  assert.equal(res.status, 101, 'stale entry must not block the new instance');
  assert.equal(b.activeConnections.size, 1);
  assert.ok(b.activeConnections.has(INSTANCE_B));
});

// ═════════════════════════════════════════════════════════════
// 4. Failed upgrade must never leave a zombie entry behind
// ═════════════════════════════════════════════════════════════

test('7. A runtime failure during the upgrade rolls the recorded connection back', async () => {
  const ThrowingDO = loadDO({ ResponseImpl: ThrowingResponse });
  const b = createBridge(ThrowingDO);

  const res = await b.fetch(wsRequest(INSTANCE_C));

  assert.equal(res.status, 500);
  assert.equal(res.body, 'Bridge upgrade failed');
  assert.equal(
    b.activeConnections.size, 0,
    'no zombie entry may linger after a failed upgrade (it would 409 other instances)'
  );
});

// ═════════════════════════════════════════════════════════════
// 5. Auth / identity guards (unchanged behaviour, kept as guards)
// ═════════════════════════════════════════════════════════════

test('8. Invalid bridge token or instanceId is rejected with 401 and records nothing', async () => {
  const b = createBridge();

  const badToken = await b.fetch(wsRequest(INSTANCE_A, { token: 'wrong-token' }));
  assert.equal(badToken.status, 401);

  const badId = await b.fetch(wsRequest('not-a-uuid'));
  assert.equal(badId.status, 401);

  const missingId = await b.fetch(wsRequest(null));
  assert.equal(missingId.status, 401);

  assert.equal(b.activeConnections.size, 0);
});

test('9. Missing Upgrade header is rejected with 426 before any connection is recorded', async () => {
  const b = createBridge();
  const res = await b.fetch(wsRequest(INSTANCE_A, { upgrade: null }));

  assert.equal(res.status, 426);
  assert.equal(b.activeConnections.size, 0);
});

// ═════════════════════════════════════════════════════════════
// 6. Replaced-socket close events must not tear down the live connection
// ═════════════════════════════════════════════════════════════

test('10. Late close event from a replaced socket keeps the new connection alive', async () => {
  const b = createBridge();
  await b.fetch(wsRequest(INSTANCE_A));
  const oldSocket = b.activeConnections.get(INSTANCE_A).socket;

  await b.fetch(wsRequest(INSTANCE_A)); // reconnect replaces the old socket
  const newSocket = b.activeConnections.get(INSTANCE_A).socket;
  assert.notEqual(newSocket, oldSocket, 'reconnect installs a new socket');

  oldSocket.dispatch('close', { code: 1000 }); // close event of the replaced socket arrives late

  assert.equal(b.activeConnections.size, 1, 'live connection must survive the replaced socket close');
  assert.equal(b.activeConnections.get(INSTANCE_A).socket, newSocket);
  assert.equal(b.activeConnections.get(INSTANCE_A).epoch, 2);
});
