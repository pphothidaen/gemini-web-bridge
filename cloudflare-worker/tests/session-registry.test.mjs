// ============================================================
// Sprint 3 Milestone — Multi-Session Registry & Load Balancing (KAN-256)
// Test-Driven Development (TDD) Red Team Specification Suite
//
// REQUIREMENTS & GUARDRAILS UNDER TEST:
// 1. Multi-Socket Coexistence & Independent Message Demuxing:
//    - Concurrent connections (Connection A and Connection B) both register in DO.
//    - Messages from Connection A are processed by activeStreams even after Connection B connects
//      (must NOT drop messages due to single `activeSocket !== server` check).
//    - Closing Connection B leaves Connection A fully operational; DO does not enter disconnected state.
// 2. In-Flight Turn Tracking:
//    - Each connection tracks its `inFlightTurns` (concurrent active turns).
//    - Starting a turn increments `inFlightTurns`; completing or failing decrements it.
// 3. Least-Loaded Connection Selection:
//    - `getLeastLoadedConnection(targetScope)` returns healthy (readyState === 1, !isStale) connection with lowest `inFlightTurns`.
//    - When Connection A has 1 turn and Connection B has 0 turns, unpinned request routes to Connection B.
// 4. Scope & Conversation Affinity (Stickiness):
//    - Matching scope (e.g. `app:conv-123`) routes to sticky connection even if another connection has lower load.
//    - Gracefully falls back when sticky connection is closed or saturated.
// 5. Failover on Connection Teardown:
//    - If primary connection drops, requests seamlessly route to remaining healthy connection.
// 6. G1 Zero-Leak Guardrail & Health Inspection:
//    - Registry serialization and `/health` expose ONLY safe metadata (`instanceId`, `inFlightTurns`, `idleSeconds`, `epoch`, `scope`).
//    - Adversarial leak tests assert zero credentials, cookies, prompts, or response texts appear in snapshots.
// ============================================================

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import * as modelCatalog from '../src/model-catalog.js';
import * as emulator from '../src/tool-emulator.ts';
import * as pdfLib from 'pdf-lib';
import * as liveness from '../src/liveness.js';
import * as geminiRefusal from '../src/gemini-refusal.js';
import * as promptTemplates from '../src/prompt-templates.js';
import { makeCtx } from './helpers/fake-ctx.mjs';

// ─── Harness Doubles ─────────────────────────────────────────────────────────

const BASE_TIME = 1_700_000_000_000;
let currentTime = BASE_TIME;

class MockDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(currentTime);
    else super(...args);
  }
  static now() {
    return currentTime;
  }
}

class MockSocket {
  constructor(opts = {}) {
    this.readyState = opts.readyState ?? 1; // 1 = OPEN, 3 = CLOSED
    this.accepted = false;
    this.sent = [];
    this.closed = null;
    this.listeners = new Map();
  }
  accept() {
    this.accepted = true;
  }
  send(data) {
    if (this.readyState !== 1) throw new Error('WebSocket is not open');
    this.sent.push(data);
  }
  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.closed = { code, reason };
    this.dispatch('close', { code, reason });
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatch(type, event) {
    for (const fn of this.listeners.get(type) || []) {
      fn(event);
    }
  }
}

class MockWebSocketPair {
  constructor() {
    this[0] = new MockSocket(); // client
    this[1] = new MockSocket(); // server (DO side)
  }
}

class MockResponse {
  constructor(body = null, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = new Headers(init.headers || {});
    this.ok = this.status >= 200 && this.status < 300;
    this.webSocket = init.webSocket ?? null;
  }
  async text() {
    return this.body == null ? '' : String(this.body);
  }
  async json() {
    return JSON.parse(await this.text());
  }
}

// ─── DO Sandbox Loader ───────────────────────────────────────────────────────

const doSource = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const doClassSrc = doSource
  .replace(/import[\s\S]*?from "[^"]+";/g, '')
  .replaceAll('export class ', 'class ')
  .replace('export default {', 'const entry = {');

const workerdCrypto = {
  randomUUID,
  getRandomValues: (arr) => globalThis.crypto.getRandomValues(arr),
  subtle: globalThis.crypto.subtle,
};

function loadDO() {
  const sandbox = {
    ...modelCatalog,
    ...emulator,
    ...pdfLib,
    ...liveness,
    ...geminiRefusal,
    ...promptTemplates,
    DurableObject: class {},
    crypto: workerdCrypto,
    Response: MockResponse,
    Request,
    Headers,
    URL,
    TextEncoder,
    TextDecoder,
    TextEncoderStream: class {},
    TransformStream,
    ReadableStream,
    WebSocketPair: MockWebSocketPair,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => {},
    Date: MockDate,
    fetch: async () => new MockResponse(JSON.stringify({ ok: true })),
  };
  sandbox.globalThis = sandbox;
  return vm.runInNewContext(doClassSrc + '\n;({GeminiBridgeDO})', sandbox).GeminiBridgeDO;
}

const GeminiBridgeDO = loadDO();

function createTestBridge(envOverrides = {}) {
  const env = {
    CLIENT_API_KEY: 'test-client-key-kan256-abcde',
    BRIDGE_AUTH_TOKEN: 'test-bridge-auth-token-kan256-12345',
    MULTI_SESSION: 'true',
    ...envOverrides,
  };
  const ctx = makeCtx({ now: () => currentTime });
  const bridge = new GeminiBridgeDO(ctx, env);
  bridge.waitForExtension = async () => {};
  return bridge;
}

/**
 * Helper to simulate an extension connecting over WebSocket to /bridge
 */
async function connectExtensionInstance(bridge, instanceId, {
  scope = 'app',
  tokens = { csrf: 'mock-csrf' },
} = {}) {
  const req = new Request(
    `https://mock.bridge/bridge?token=${encodeURIComponent(bridge.env.BRIDGE_AUTH_TOKEN)}&client=background_sw&instanceId=${encodeURIComponent(instanceId)}`,
    {
      method: 'GET',
      headers: {
        'x-bridge-token': bridge.env.BRIDGE_AUTH_TOKEN,
        Upgrade: 'websocket',
      },
    }
  );
  const res = await bridge.fetch(req);
  const connState = bridge.activeConnections?.get(instanceId);
  const server = connState?.socket;

  if (res.status === 101 && server) {
    server.dispatch('message', {
      data: JSON.stringify({
        type: 'SESSION_READY',
        protocolVersion: 3,
        scope,
        tokens,
      }),
    });
    server.dispatch('message', {
      data: JSON.stringify({
        type: 'MODELS_DISCOVERED',
        protocolVersion: 3,
        activeModel: '3.8 Flash',
        models: [{
          id: 'gemini-3.8-flash',
          name: '3.8 Flash',
          thinking: true,
          verification: 'verified',
        }],
      }),
    });
  }

  return {
    status: res.status,
    response: res,
    server,
    client: res.webSocket,
    connState,
  };
}

beforeEach(() => {
  currentTime = BASE_TIME;
});

// =====================================================================
// 1. MULTI-SOCKET COEXISTENCE & INDEPENDENT MESSAGE DEMUXING (Req 1)
// =====================================================================

test('coexistence: DO accepts and registers multiple concurrent connections without 409 Conflict', async () => {
  const bridge = createTestBridge();

  // Connection A connects
  const connA = await connectExtensionInstance(bridge, 'inst-alpha', { scope: 'app' });
  assert.equal(connA.status, 101, 'Connection A must upgrade with HTTP 101');
  assert.ok(bridge.activeConnections.has('inst-alpha'), 'inst-alpha must be in activeConnections');

  // Connection B connects concurrently
  const connB = await connectExtensionInstance(bridge, 'inst-beta', { scope: 'app' });
  assert.equal(
    connB.status,
    101,
    'Connection B must upgrade with HTTP 101 without 409 Conflict rejection'
  );
  assert.ok(bridge.activeConnections.has('inst-beta'), 'inst-beta must be in activeConnections');

  // DO registers both in its session registry
  assert.equal(bridge.activeConnections.size, 2, 'activeConnections must contain exactly 2 connections');
});

test('coexistence: registry maintains distinct connection states and sockets for each active instanceId', async () => {
  const bridge = createTestBridge();

  const connA = await connectExtensionInstance(bridge, 'inst-alpha');
  const connB = await connectExtensionInstance(bridge, 'inst-beta');

  assert.equal(connA.status, 101);
  assert.equal(connB.status, 101);

  const stateA = bridge.activeConnections.get('inst-alpha');
  const stateB = bridge.activeConnections.get('inst-beta');

  assert.ok(stateA, 'stateA must exist');
  assert.ok(stateB, 'stateB must exist');
  assert.notEqual(stateA, stateB, 'stateA and stateB must be distinct connection state instances');
  assert.notEqual(stateA.socket, stateB.socket, 'Sockets for inst-alpha and inst-beta must be distinct');
});

test('demuxing: messages from Connection A are processed by activeStreams even after Connection B has connected', async () => {
  const bridge = createTestBridge();

  const connA = await connectExtensionInstance(bridge, 'inst-alpha');
  const connB = await connectExtensionInstance(bridge, 'inst-beta');

  assert.equal(connA.status, 101);
  assert.equal(connB.status, 101);

  const receivedA = [];
  const receivedB = [];

  // Register two distinct in-flight active streams
  bridge.activeStreams.set('req-stream-alpha-1', (msg) => {
    receivedA.push(msg);
  });
  bridge.activeStreams.set('req-stream-beta-2', (msg) => {
    receivedB.push(msg);
  });

  // Connection A dispatches a chunk for its stream
  connA.server.dispatch('message', {
    data: JSON.stringify({
      type: 'STREAM_CHUNK',
      requestId: 'req-stream-alpha-1',
      chunk: 'chunk-from-inst-alpha',
    }),
  });

  // Connection B dispatches a chunk for its stream
  connB.server.dispatch('message', {
    data: JSON.stringify({
      type: 'STREAM_CHUNK',
      requestId: 'req-stream-beta-2',
      chunk: 'chunk-from-inst-beta',
    }),
  });

  assert.equal(
    receivedA.length,
    1,
    'Message from Connection A must NOT be dropped due to single activeSocket check'
  );
  assert.equal(receivedA[0].chunk, 'chunk-from-inst-alpha');

  assert.equal(
    receivedB.length,
    1,
    'Message from Connection B must be dispatched to its active stream'
  );
  assert.equal(receivedB[0].chunk, 'chunk-from-inst-beta');
});

test('teardown independence: closing Connection B leaves Connection A fully operational and ready', async () => {
  const bridge = createTestBridge();

  const connA = await connectExtensionInstance(bridge, 'inst-alpha');
  const connB = await connectExtensionInstance(bridge, 'inst-beta');

  assert.equal(connA.status, 101);
  assert.equal(connB.status, 101);

  // Close Connection B
  connB.server.close(1000, 'Normal closure');

  // Connection B removed
  assert.equal(bridge.activeConnections.has('inst-beta'), false, 'inst-beta must be removed on close');

  // Connection A MUST remain operational
  assert.equal(bridge.activeConnections.has('inst-alpha'), true, 'inst-alpha must remain registered');
  assert.equal(bridge.isExtensionReady(), true, 'DO must report ready while Connection A is connected');
  assert.equal(bridge.socketLostAt, null, 'socketLostAt must NOT be set while Connection A is alive');

  // Connection A can still process incoming stream frames
  const streamEvents = [];
  bridge.activeStreams.set('req-stream-alpha-survivor', (msg) => {
    streamEvents.push(msg);
  });

  connA.server.dispatch('message', {
    data: JSON.stringify({
      type: 'STREAM_CHUNK',
      requestId: 'req-stream-alpha-survivor',
      chunk: 'still-alive-chunk',
    }),
  });

  assert.equal(streamEvents.length, 1, 'Connection A must continue processing streams after Connection B closes');
});

test('teardown independence: closing Connection B does NOT abort active streams on Connection A', async () => {
  const bridge = createTestBridge();

  const connA = await connectExtensionInstance(bridge, 'inst-alpha');
  const connB = await connectExtensionInstance(bridge, 'inst-beta');

  assert.equal(connA.status, 101);
  assert.equal(connB.status, 101);

  const errorsOnA = [];
  bridge.activeStreams.set('req-stream-alpha-live', (msg) => {
    if (msg.type === 'STREAM_ERROR') errorsOnA.push(msg);
  });

  // Close Connection B
  connB.server.close(1000, 'Connection B closed');

  assert.equal(
    errorsOnA.length,
    0,
    'Closing Connection B must NOT broadcast STREAM_ERROR to active streams on Connection A'
  );
  assert.ok(
    bridge.activeStreams.has('req-stream-alpha-live'),
    'Stream on Connection A must remain in activeStreams'
  );
});

// =====================================================================
// 2. IN-FLIGHT TURN TRACKING (Req 2)
// =====================================================================

test('turn tracking: connection state initializes inFlightTurns to 0 upon registration', async () => {
  const bridge = createTestBridge();

  const connA = await connectExtensionInstance(bridge, 'inst-alpha');
  assert.equal(connA.status, 101);

  const stateA = bridge.activeConnections.get('inst-alpha');
  assert.ok(stateA, 'Connection state for inst-alpha must exist');
  assert.equal(
    typeof stateA.inFlightTurns,
    'number',
    'state.inFlightTurns must be defined as a number'
  );
  assert.equal(stateA.inFlightTurns, 0, 'state.inFlightTurns must initialize to 0');
});

test('turn tracking: beginTurn increments inFlightTurns for the specified connection', async () => {
  const bridge = createTestBridge();

  await connectExtensionInstance(bridge, 'inst-alpha');
  const stateA = bridge.activeConnections.get('inst-alpha');

  assert.equal(typeof bridge.beginTurn, 'function', 'GeminiBridgeDO must provide beginTurn(instanceId)');

  const turnsAfter1 = bridge.beginTurn('inst-alpha');
  assert.equal(turnsAfter1, 1, 'beginTurn must return incremented turn count');
  assert.equal(stateA.inFlightTurns, 1, 'inFlightTurns must be 1 after first turn starts');

  const turnsAfter2 = bridge.beginTurn('inst-alpha');
  assert.equal(turnsAfter2, 2, 'beginTurn must return incremented turn count');
  assert.equal(stateA.inFlightTurns, 2, 'inFlightTurns must be 2 after second turn starts');
});

test('turn tracking: endTurn decrements inFlightTurns for the specified connection', async () => {
  const bridge = createTestBridge();

  await connectExtensionInstance(bridge, 'inst-alpha');
  const stateA = bridge.activeConnections.get('inst-alpha');

  assert.equal(typeof bridge.endTurn, 'function', 'GeminiBridgeDO must provide endTurn(instanceId)');

  bridge.beginTurn('inst-alpha');
  bridge.beginTurn('inst-alpha');
  assert.equal(stateA.inFlightTurns, 2);

  const turnsAfterEnd1 = bridge.endTurn('inst-alpha');
  assert.equal(turnsAfterEnd1, 1, 'endTurn must return decremented turn count');
  assert.equal(stateA.inFlightTurns, 1, 'inFlightTurns must be 1');

  const turnsAfterEnd2 = bridge.endTurn('inst-alpha');
  assert.equal(turnsAfterEnd2, 0, 'endTurn must return decremented turn count');
  assert.equal(stateA.inFlightTurns, 0, 'inFlightTurns must be 0');
});

test('turn tracking: endTurn clamps at 0 and does not decrement below zero', async () => {
  const bridge = createTestBridge();

  await connectExtensionInstance(bridge, 'inst-alpha');
  const stateA = bridge.activeConnections.get('inst-alpha');

  assert.equal(typeof bridge.endTurn, 'function');
  const clamped = bridge.endTurn('inst-alpha');

  assert.equal(clamped, 0, 'endTurn on idle connection must clamp at 0');
  assert.equal(stateA.inFlightTurns, 0, 'inFlightTurns must never be negative');
});

test('turn tracking: turn execution failure properly decrements inFlightTurns (no leak on error)', async () => {
  const bridge = createTestBridge();

  await connectExtensionInstance(bridge, 'inst-alpha');
  const stateA = bridge.activeConnections.get('inst-alpha');

  assert.equal(typeof bridge.beginTurn, 'function');
  assert.equal(typeof bridge.endTurn, 'function');

  // Start turn
  bridge.beginTurn('inst-alpha');
  assert.equal(stateA.inFlightTurns, 1);

  // Simulate turn failure with try/finally pattern
  try {
    throw new Error('Simulated upstream failure during turn');
  } catch {
    bridge.endTurn('inst-alpha');
  }

  assert.equal(
    stateA.inFlightTurns,
    0,
    'inFlightTurns must be decremented on error to prevent slot exhaustion leaks'
  );
});

// =====================================================================
// 3. LEAST-LOADED CONNECTION SELECTION (Req 3)
// =====================================================================

test('least-loaded: getLeastLoadedConnection returns the healthy connection with lowest inFlightTurns', async () => {
  const bridge = createTestBridge();

  await connectExtensionInstance(bridge, 'inst-alpha');
  await connectExtensionInstance(bridge, 'inst-beta');

  assert.equal(
    typeof bridge.getLeastLoadedConnection,
    'function',
    'GeminiBridgeDO must provide getLeastLoadedConnection(targetScope)'
  );

  // inst-alpha has 1 in-flight turn, inst-beta has 0 in-flight turns
  bridge.beginTurn('inst-alpha');

  const chosen = bridge.getLeastLoadedConnection();
  assert.ok(chosen, 'A connection must be chosen');
  assert.equal(
    chosen.instanceId,
    'inst-beta',
    'New unpinned request must route to inst-beta (0 turns) over inst-alpha (1 turn)'
  );
});

test('least-loaded: dynamically switches between Connection A and Connection B as load changes', async () => {
  const bridge = createTestBridge();

  await connectExtensionInstance(bridge, 'inst-alpha');
  await connectExtensionInstance(bridge, 'inst-beta');

  assert.equal(typeof bridge.getLeastLoadedConnection, 'function');

  // Both start at 0 turns. One is chosen:
  const first = bridge.getLeastLoadedConnection();
  assert.ok(first);

  // Put 2 turns on inst-beta, 1 turn on inst-alpha
  bridge.beginTurn('inst-beta');
  bridge.beginTurn('inst-beta');
  bridge.beginTurn('inst-alpha');

  const chosen = bridge.getLeastLoadedConnection();
  assert.equal(
    chosen.instanceId,
    'inst-alpha',
    'Must choose inst-alpha (1 turn) when inst-beta has 2 turns'
  );

  // Complete turn on inst-beta so inst-beta drops to 0 turns
  bridge.endTurn('inst-beta');
  bridge.endTurn('inst-beta');

  const chosenAfter = bridge.getLeastLoadedConnection();
  assert.equal(
    chosenAfter.instanceId,
    'inst-beta',
    'Must switch to inst-beta once it becomes least loaded'
  );
});

test('least-loaded: excludes closed connections (readyState !== 1) even if inFlightTurns is 0', async () => {
  const bridge = createTestBridge();

  const connA = await connectExtensionInstance(bridge, 'inst-alpha');
  const connB = await connectExtensionInstance(bridge, 'inst-beta');

  assert.equal(typeof bridge.getLeastLoadedConnection, 'function');

  // inst-alpha has 2 in-flight turns
  bridge.beginTurn('inst-alpha');
  bridge.beginTurn('inst-alpha');

  // inst-beta has 0 in-flight turns, but its socket is closed
  connB.server.close(1000, 'Test socket closed');

  const chosen = bridge.getLeastLoadedConnection();
  assert.ok(chosen, 'Should still pick available open connection');
  assert.equal(
    chosen.instanceId,
    'inst-alpha',
    'Closed connection must be excluded even if inFlightTurns is 0'
  );
});

test('least-loaded: excludes stale connections that missed keepalive ping/pong', async () => {
  const bridge = createTestBridge();

  await connectExtensionInstance(bridge, 'inst-alpha');
  await connectExtensionInstance(bridge, 'inst-beta');

  assert.equal(typeof bridge.getLeastLoadedConnection, 'function');

  // inst-alpha has 0 turns but is stale (unresponsive past keepalive grace)
  const stateA = bridge.activeConnections.get('inst-alpha');
  stateA.lastActivityAt = currentTime - (bridge.STALE_CONNECTION_TIMEOUT_MS + 20_000);
  stateA.lastPingAt = currentTime - 45_000;
  stateA.lastPongAt = currentTime - 200_000;

  // inst-beta has 1 turn and is fresh/responsive
  bridge.beginTurn('inst-beta');
  const stateB = bridge.activeConnections.get('inst-beta');
  stateB.lastActivityAt = currentTime - 1_000;
  stateB.lastPingAt = currentTime - 500;
  stateB.lastPongAt = currentTime - 400;

  const chosen = bridge.getLeastLoadedConnection();
  assert.ok(chosen);
  assert.equal(
    chosen.instanceId,
    'inst-beta',
    'Stale connection inst-alpha must be excluded from least-loaded selection'
  );
});

test('least-loaded: returns null when all registered connections are closed or stale', async () => {
  const bridge = createTestBridge();

  const connA = await connectExtensionInstance(bridge, 'inst-alpha');
  const connB = await connectExtensionInstance(bridge, 'inst-beta');

  assert.equal(typeof bridge.getLeastLoadedConnection, 'function');

  connA.server.close(1000, 'Closed');
  connB.server.close(1000, 'Closed');

  const chosen = bridge.getLeastLoadedConnection();
  assert.equal(
    chosen,
    null,
    'getLeastLoadedConnection must return null when no healthy connections exist'
  );
});

// =====================================================================
// 4. SCOPE & CONVERSATION AFFINITY (STICKINESS) (Req 4)
// =====================================================================

test('scope affinity: getLeastLoadedConnection with targetScope routes to connection with matching scope', async () => {
  const bridge = createTestBridge();

  await connectExtensionInstance(bridge, 'inst-alpha', { scope: 'app:conv-123' });
  await connectExtensionInstance(bridge, 'inst-beta', { scope: 'app:conv-456' });

  assert.equal(typeof bridge.getLeastLoadedConnection, 'function');

  // Both have 0 turns; query for app:conv-123
  const chosen = bridge.getLeastLoadedConnection('app:conv-123');
  assert.ok(chosen);
  assert.equal(
    chosen.instanceId,
    'inst-alpha',
    'Target scope app:conv-123 must route to inst-alpha'
  );

  // Query for app:conv-456
  const chosenB = bridge.getLeastLoadedConnection('app:conv-456');
  assert.ok(chosenB);
  assert.equal(
    chosenB.instanceId,
    'inst-beta',
    'Target scope app:conv-456 must route to inst-beta'
  );
});

test('scope affinity: matching scope wins over a connection with fewer in-flight turns', async () => {
  const bridge = createTestBridge();

  await connectExtensionInstance(bridge, 'inst-alpha', { scope: 'app:conv-pinned' });
  await connectExtensionInstance(bridge, 'inst-beta', { scope: 'app:conv-other' });

  assert.equal(typeof bridge.getLeastLoadedConnection, 'function');

  // inst-alpha has 1 in-flight turn, inst-beta has 0 in-flight turns
  bridge.beginTurn('inst-alpha');

  // Request for app:conv-pinned should remain sticky to inst-alpha
  const chosen = bridge.getLeastLoadedConnection('app:conv-pinned');
  assert.ok(chosen);
  assert.equal(
    chosen.instanceId,
    'inst-alpha',
    'Scope affinity must route to sticky connection even when another connection has 0 turns'
  );
});

test('scope affinity: gracefully falls back to least-loaded connection when sticky connection is closed', async () => {
  const bridge = createTestBridge();

  const connA = await connectExtensionInstance(bridge, 'inst-alpha', { scope: 'app:conv-sticky' });
  await connectExtensionInstance(bridge, 'inst-beta', { scope: 'app' });

  assert.equal(typeof bridge.getLeastLoadedConnection, 'function');

  // Sticky Connection A closes abruptly
  connA.server.close(1006, 'Abrupt socket termination');

  // Next request for app:conv-sticky should fail over to inst-beta rather than error or return null
  const fallback = bridge.getLeastLoadedConnection('app:conv-sticky');
  assert.ok(fallback, 'Must provide fallback connection when sticky connection is dead');
  assert.equal(
    fallback.instanceId,
    'inst-beta',
    'Should rebind/route to healthy available connection inst-beta'
  );
});

test('scope affinity: gracefully falls back or rebinds when sticky connection reaches saturation limit', async () => {
  const bridge = createTestBridge();

  await connectExtensionInstance(bridge, 'inst-alpha', { scope: 'app:conv-saturated' });
  await connectExtensionInstance(bridge, 'inst-beta', { scope: 'app' });

  assert.equal(typeof bridge.getLeastLoadedConnection, 'function');

  // Saturate inst-alpha (e.g. 5 concurrent turns, exceeding connection capacity)
  for (let i = 0; i < 5; i++) {
    bridge.beginTurn('inst-alpha');
  }

  // Next request for saturated scope should spill over to inst-beta
  const chosen = bridge.getLeastLoadedConnection('app:conv-saturated');
  assert.ok(chosen);
  assert.equal(
    chosen.instanceId,
    'inst-beta',
    'Saturated sticky connection must spill over to available connection inst-beta'
  );
});

// =====================================================================
// 5. FAILOVER ON CONNECTION TEARDOWN (Req 5)
// =====================================================================

test('failover: dropping the primary connection seamlessly routes subsequent requests to remaining healthy connection', async () => {
  const bridge = createTestBridge();

  const connA = await connectExtensionInstance(bridge, 'inst-primary');
  const connB = await connectExtensionInstance(bridge, 'inst-secondary');

  assert.equal(typeof bridge.getLeastLoadedConnection, 'function');

  // Primary connection drops
  connA.server.close(1006, 'Connection dropped');

  // Subsequent route request must seamlessly resolve to inst-secondary
  const nextTarget = bridge.getLeastLoadedConnection();
  assert.ok(nextTarget, 'Must have active target connection after primary teardown');
  assert.equal(
    nextTarget.instanceId,
    'inst-secondary',
    'Subsequent request must route to inst-secondary'
  );
});

test('failover: extension_status remains CONNECTED_AND_READY after primary drops if secondary is alive', async () => {
  const bridge = createTestBridge();

  const connA = await connectExtensionInstance(bridge, 'inst-primary');
  await connectExtensionInstance(bridge, 'inst-secondary');

  // Verify initial ready state
  assert.equal(bridge.isExtensionReady(), true);

  // Drop primary connection
  connA.server.close(1000, 'Primary detached');

  // DO must remain CONNECTED_AND_READY through the secondary connection
  assert.equal(
    bridge.isExtensionReady(),
    true,
    'DO status must remain CONNECTED_AND_READY as long as any healthy connection remains'
  );

  const healthRes = await bridge.fetch(new Request('https://mock.bridge/health'));
  const healthBody = await healthRes.json();
  assert.equal(
    healthBody.extension_status,
    'CONNECTED_AND_READY',
    '/health must reflect CONNECTED_AND_READY'
  );
  assert.equal(
    healthBody.instance_tracking.active_connections_count,
    1,
    'Active connections count must reflect 1 remaining connection'
  );
});

test('failover: in-flight turns on dropped connection are cleaned up while other connections continue uninterrupted', async () => {
  const bridge = createTestBridge();

  const connA = await connectExtensionInstance(bridge, 'inst-alpha');
  await connectExtensionInstance(bridge, 'inst-beta');

  assert.equal(typeof bridge.beginTurn, 'function');
  assert.equal(typeof bridge.endTurn, 'function');

  // Set 2 in-flight turns on inst-alpha and 1 in-flight turn on inst-beta
  bridge.beginTurn('inst-alpha');
  bridge.beginTurn('inst-alpha');
  bridge.beginTurn('inst-beta');

  // inst-alpha drops
  connA.server.close(1006, 'Abnormal network cut');

  // inst-alpha is removed from registry
  assert.equal(bridge.activeConnections.has('inst-alpha'), false);

  // inst-beta is unaffected and retains its turn tracking
  const stateB = bridge.activeConnections.get('inst-beta');
  assert.ok(stateB);
  assert.equal(stateB.inFlightTurns, 1, 'inst-beta turns must remain intact');

  // Completing turn on inst-beta works cleanly
  bridge.endTurn('inst-beta');
  assert.equal(stateB.inFlightTurns, 0);
});

// =====================================================================
// 6. G1 ZERO-LEAK GUARDRAIL & HEALTH INSPECTION (Req 6)
// =====================================================================

test('G1 guardrail: /health reports safe connection metadata including inFlightTurns and scope', async () => {
  const bridge = createTestBridge();

  await connectExtensionInstance(bridge, 'inst-health-1', { scope: 'app:conv-abc' });
  await connectExtensionInstance(bridge, 'inst-health-2', { scope: 'app:conv-xyz' });

  const healthRes = await bridge.fetch(new Request('https://mock.bridge/health'));
  assert.equal(healthRes.status, 200);

  const healthBody = await healthRes.json();
  const connections = healthBody.instance_tracking?.connections;

  assert.ok(Array.isArray(connections), 'health response must include connections array');
  assert.equal(connections.length, 2, 'connections array must contain 2 entries');

  const allowedKeys = new Set([
    'instanceId',
    'inFlightTurns',
    'idleSeconds',
    'epoch',
    'scope',
    'isStale',
    'connectedAt',
    'lastActivityAt',
  ]);

  for (const conn of connections) {
    // Assert required fields
    assert.ok(typeof conn.instanceId === 'string' && conn.instanceId.length > 0);
    assert.equal(typeof conn.inFlightTurns, 'number', 'inFlightTurns must be reported in /health');
    assert.equal(typeof conn.idleSeconds, 'number');
    assert.equal(typeof conn.epoch, 'number');
    assert.ok(typeof conn.scope === 'string', 'scope must be reported in /health');

    // Assert strictly no unexpected keys
    for (const key of Object.keys(conn)) {
      assert.ok(
        allowedKeys.has(key),
        `G1 Violation: Disallowed property "${key}" in /health connection item`
      );
    }
  }
});

test('G1 guardrail: registry serialization / snapshot method returns strictly safe metadata', async () => {
  const bridge = createTestBridge();

  await connectExtensionInstance(bridge, 'inst-snap-1', { scope: 'app' });

  assert.equal(
    typeof bridge.getRegistrySnapshot,
    'function',
    'GeminiBridgeDO must provide getRegistrySnapshot() for safe introspection'
  );

  const snapshot = bridge.getRegistrySnapshot();
  assert.ok(Array.isArray(snapshot) || typeof snapshot === 'object');

  const serialized = JSON.stringify(snapshot);

  // Strictly forbid sensitive property keys
  const forbiddenPatterns = [
    /prompt/i,
    /query/i,
    /cookie/i,
    /token/i,
    /snlm0e/i,
    /secret/i,
    /credential/i,
    /auth/i,
  ];

  for (const pattern of forbiddenPatterns) {
    assert.ok(
      !pattern.test(serialized),
      `G1 Violation: Registry snapshot matched forbidden pattern ${pattern}: ${serialized}`
    );
  }
});

test('G1 adversarial: registry snapshots and /health NEVER leak secret keys, tokens, cookies, or prompt/response text', async () => {
  const SENSITIVE_STRINGS = [
    'test-client-key-kan256-abcde',
    'test-bridge-auth-token-kan256-12345',
    'SNlM0e=AIzaSy_ADVERSARIAL_LEAK_TOKEN_9999',
    'CONFIDENTIAL_USER_PROMPT_DO_NOT_EXPOSE_PROPRIETARY_DATA',
    'SECRET_BANKING_USER_QUERY_ACCOUNT_BALANCE_7777',
    'SENSITIVE_AI_MODEL_GENERATED_RESPONSE_TOP_SECRET_CODE',
    'Bearer adversarial-auth-secret-token',
  ];

  const bridge = createTestBridge({
    CLIENT_API_KEY: 'test-client-key-kan256-abcde',
    BRIDGE_AUTH_TOKEN: 'test-bridge-auth-token-kan256-12345',
  });

  const connA = await connectExtensionInstance(bridge, 'inst-adversarial-1');
  const connB = await connectExtensionInstance(bridge, 'inst-adversarial-2');

  // Adversarial injection of sensitive secrets into connection states and DO internals
  const stateA = bridge.activeConnections.get('inst-adversarial-1');
  const stateB = bridge.activeConnections.get('inst-adversarial-2');

  if (stateA) {
    stateA.tokens = { SNlM0e: 'SNlM0e=AIzaSy_ADVERSARIAL_LEAK_TOKEN_9999' };
    stateA.lastPrompt = 'CONFIDENTIAL_USER_PROMPT_DO_NOT_EXPOSE_PROPRIETARY_DATA';
    stateA.lastQuery = 'SECRET_BANKING_USER_QUERY_ACCOUNT_BALANCE_7777';
    stateA.bearer = 'Bearer adversarial-auth-secret-token';
  }

  if (stateB) {
    stateB.response = 'SENSITIVE_AI_MODEL_GENERATED_RESPONSE_TOP_SECRET_CODE';
    stateB.cookie = 'SNlM0e=AIzaSy_ADVERSARIAL_LEAK_TOKEN_9999';
  }

  // 1. Check /health serialization
  const healthRes = await bridge.fetch(new Request('https://mock.bridge/health'));
  const healthText = await healthRes.text();

  for (const secret of SENSITIVE_STRINGS) {
    assert.ok(
      !healthText.includes(secret) && !healthText.toLowerCase().includes(secret.toLowerCase()),
      `G1 ADVERSARIAL LEAK: /health leaked sensitive string: "${secret}"`
    );
  }

  // 2. Check snapshot serialization if method exists
  if (typeof bridge.getRegistrySnapshot === 'function') {
    const snapshotText = JSON.stringify(bridge.getRegistrySnapshot());
    for (const secret of SENSITIVE_STRINGS) {
      assert.ok(
        !snapshotText.includes(secret) && !snapshotText.toLowerCase().includes(secret.toLowerCase()),
        `G1 ADVERSARIAL LEAK: snapshot leaked sensitive string: "${secret}"`
      );
    }
  }
});
