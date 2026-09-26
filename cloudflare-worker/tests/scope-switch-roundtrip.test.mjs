// ===========================================================
// Gemini Web-Bridge: server-initiated scope switch round-trip
//
// Guards the live failure where `horo_consult` (which defaults to a
// notebook scope) failed with:
//
//   ERROR: {code: -32602, message: "Scope switch to
//           'notebook:<id>' timed out (45s)"}
//
// Root cause: in the WebSocket "message" dispatcher, the SCOPE_READY
// branch of an `else if` chain handled the message and never fell
// through to the generic `activeStreams` dispatch. prepareScope()
// registers its resolver in activeStreams and waits for a per-request
// SCOPE_READY, so the confirmation was swallowed and the promise timed
// out -- even though the tab had already navigated and confirmed, and
// `this.currentScope` had in fact been updated by that same branch.
//
// Every pre-existing test stubbed `prepareScope` outright, so the real
// one was never exercised. These tests drive the actual socket listener.
//
// Run: node --test tests/scope-switch-roundtrip.test.mjs
// ===========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import * as modelCatalog from '../src/model-catalog.js';

// -- Load DO source and strip Cloudflare imports ----------------
const doSource = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

const doClassSrc = doSource
  .replace(/import[\s\S]*?from "[^"]+";/g, '')
  .replaceAll('export class ', 'class ')
  .replace('export default {', 'const entry = {');

// Workers expose WebCrypto only -- keep the harness honest.
const workerdCrypto = {
  randomUUID,
  getRandomValues: (arr) => globalThis.crypto.getRandomValues(arr),
  subtle: globalThis.crypto.subtle,
};

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
  /** Deliver an extension -> server message through the real listener. */
  emit(msg) { this.dispatch('message', { data: JSON.stringify(msg) }); }
  /** All messages sent server -> extension, parsed. */
  sentMessages() { return this.sent.map((raw) => JSON.parse(raw)); }
}

class MockWebSocketPair {
  constructor() {
    this[0] = new MockSocket();
    this[1] = new MockSocket();
  }
}

class MockResponse {
  constructor(body = null, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = init.headers || {};
    this.webSocket = init.webSocket ?? null;
  }
  async text() { return this.body == null ? '' : String(this.body); }
}

function loadDO() {
  const context = {
    ...modelCatalog,
    DurableObject: class {},
    crypto: workerdCrypto,
    Response: MockResponse,
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
const INSTANCE_A = '4e2b3729-f87d-43da-8ad4-6f88f1864bce';
const NOTEBOOK = 'b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0';

function createBridge() {
  return new GeminiBridgeDO({}, { BRIDGE_AUTH_TOKEN: BRIDGE_TOKEN, CLIENT_API_TOKEN: 'client-token' });
}

function wsRequest(instanceId) {
  const qs = `?token=${BRIDGE_TOKEN}&client=background_sw&instanceId=${instanceId}`;
  return new Request(`https://bridge.test/bridge${qs}`, {
    method: 'GET',
    headers: { 'x-bridge-token': BRIDGE_TOKEN, Upgrade: 'websocket', 'x-instance-id': instanceId },
  });
}

/** Connect the extension and return the server-side socket. */
async function connectedBridge(instanceId = INSTANCE_A) {
  const b = createBridge();
  const res = await b.fetch(wsRequest(instanceId));
  assert.equal(res.status, 101, 'handshake must succeed before scope tests');
  const server = b.activeConnections.get(instanceId).socket;
  server.emit({ type: 'SESSION_READY', tokens: { SNlM0e: 'x' }, models: [], scope: 'app' });
  return { b, server };
}

/**
 * Race a promise against a short sentinel so a regression fails fast
 * instead of hanging for the 45s production timeout.
 */
function withDeadline(promise, ms = 750, label = 'promise') {
  let timer;
  const sentinel = Symbol('timeout');
  const guard = new Promise((resolve) => { timer = setTimeout(() => resolve(sentinel), ms); });
  return Promise.race([promise, guard])
    .finally(() => clearTimeout(timer))
    .then((v) => {
      if (v === sentinel) throw new Error(`${label} did not settle within ${ms}ms (production timeout is 45s)`);
      return v;
    });
}

// ═════════════════════════════════════════════════════════════
// 1. The regression: SCOPE_READY must resolve prepareScope()
// ═════════════════════════════════════════════════════════════

test('1. SCOPE_READY with the requestId resolves prepareScope (was a 45s timeout)', async () => {
  const { b, server } = await connectedBridge();

  const pending = b.prepareScope(`notebook:${NOTEBOOK}`);
  pending.catch(() => {}); // never let a 45s rejection surface as unhandled

  const prepare = server.sentMessages().find((m) => m.type === 'PREPARE_SCOPE');
  assert.ok(prepare, 'server must emit PREPARE_SCOPE down the socket');
  assert.equal(prepare.scope, `notebook:${NOTEBOOK}`);
  assert.ok(prepare.requestId, 'PREPARE_SCOPE carries a requestId to correlate on');

  // The extension confirms after the tab navigated to the notebook.
  server.emit({ type: 'SCOPE_READY', requestId: prepare.requestId, scope: `notebook:${NOTEBOOK}` });

  const ready = await withDeadline(pending, 750, 'prepareScope()');
  assert.equal(ready.type, 'SCOPE_READY');
  assert.equal(ready.scope, `notebook:${NOTEBOOK}`);
  assert.equal(b.currentScope, `notebook:${NOTEBOOK}`, 'currentScope tracked for the fail-closed guard');
});

test('2. prepareScope cleans up its activeStreams entry after resolving', async () => {
  const { b, server } = await connectedBridge();

  const pending = b.prepareScope(`notebook:${NOTEBOOK}`);
  pending.catch(() => {});
  const prepare = server.sentMessages().find((m) => m.type === 'PREPARE_SCOPE');
  assert.ok(b.activeStreams.has(prepare.requestId), 'registered while in flight');

  server.emit({ type: 'SCOPE_READY', requestId: prepare.requestId, scope: `notebook:${NOTEBOOK}` });
  await withDeadline(pending, 750, 'prepareScope()');

  assert.equal(b.activeStreams.has(prepare.requestId), false, 'no leaked handler/timer after success');
});

// ═════════════════════════════════════════════════════════════
// 2. STREAM_ERROR must still reject (fail-closed path preserved)
// ═════════════════════════════════════════════════════════════

test('3. STREAM_ERROR rejects prepareScope with the extension error code', async () => {
  const { b, server } = await connectedBridge();

  const pending = b.prepareScope(`notebook:${NOTEBOOK}`);
  pending.catch(() => {});
  const prepare = server.sentMessages().find((m) => m.type === 'PREPARE_SCOPE');

  server.emit({
    type: 'STREAM_ERROR',
    requestId: prepare.requestId,
    error: "Tab scope 'app' does not match requested scope (background navigation pending)",
    code: 'scope_mismatch',
  });

  await assert.rejects(withDeadline(pending, 750, 'prepareScope()'), (err) => {
    assert.equal(err.code, 'scope_mismatch');
    assert.match(err.message, /does not match requested scope/);
    return true;
  });
  assert.equal(b.activeStreams.has(prepare.requestId), false, 'entry removed on failure too');
});

// ═════════════════════════════════════════════════════════════
// 3. Correlation guards: a foreign/missing requestId must not resolve
// ═════════════════════════════════════════════════════════════

test('4. SCOPE_READY without a matching requestId does not resolve a pending switch', async () => {
  const { b, server } = await connectedBridge();

  const pending = b.prepareScope(`notebook:${NOTEBOOK}`);
  pending.catch(() => {});
  const prepare = server.sentMessages().find((m) => m.type === 'PREPARE_SCOPE');

  // An unrelated confirmation (no requestId) must not satisfy the pending switch.
  server.emit({ type: 'SCOPE_READY', scope: `notebook:${NOTEBOOK}` });

  await new Promise((r) => setTimeout(r, 100));
  assert.equal(b.activeStreams.has(prepare.requestId), true, 'still awaiting its own confirmation');
  void pending;
});

test('5. disconnected extension rejects immediately instead of waiting 45s', async () => {
  const { b, server } = await connectedBridge();
  server.close(1000, 'test teardown');

  await assert.rejects(withDeadline(b.prepareScope('app'), 750, 'prepareScope()'), (err) => {
    assert.equal(err.code, 'extension_disconnected');
    return true;
  });
});

// ═════════════════════════════════════════════════════════════
// 4. Dispatcher guard: SCOPE_READY must reach activeStreams
// ═════════════════════════════════════════════════════════════

test('6. dispatcher forwards SCOPE_READY to any activeStreams handler (no swallow)', async () => {
  const { b, server } = await connectedBridge();
  const seen = [];
  b.activeStreams.set('req-42', (msg) => seen.push(msg));

  server.emit({ type: 'SCOPE_READY', requestId: 'req-42', scope: 'app' });

  assert.equal(seen.length, 1, 'SCOPE_READY must reach the registered handler');
  assert.equal(seen[0].type, 'SCOPE_READY');
  assert.equal(seen[0].requestId, 'req-42');
  assert.equal(b.currentScope, 'app');
});

test('7. non-matching requestId leaves a pending handler untouched', async () => {
  const { b, server } = await connectedBridge();
  const seen = [];
  b.activeStreams.set('req-42', (msg) => seen.push(msg));

  server.emit({ type: 'SCOPE_READY', requestId: 'req-OTHER', scope: 'app' });

  assert.equal(seen.length, 0, 'a foreign requestId must not resolve this switch');
  assert.equal(b.activeStreams.has('req-42'), true);
});

