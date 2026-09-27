/**
 * KAN-163: RECONNECTING must be a waiting state, not a terminal one.
 *
 * The failure this exists to prevent: connect() refused to start a new attempt
 * while the state was RECONNECTING, treating "a backoff timer is armed" the
 * same as "a socket is already in flight". But both scheduleReconnect() and
 * _onConflict() set RECONNECTING, and the timers they arm call connect(). So
 * every path into RECONNECTING ended at that guard, _doConnectInternal() was
 * never reached, and no code path could ever move the state back out. The
 * service worker was stuck permanently disconnected.
 *
 * Production evidence (2026-09-27, after the KAN-162 reload):
 *   [BridgeSocket] Cannot send: WebSocket not open. SESSION_READY
 * with `wrangler tail` showing zero /bridge requests for 15+ minutes — the
 * client was alive and trying to publish state, but never dialled out.
 *
 * These tests drive the real BridgeSocketManager with a fake WebSocket, so
 * they exercise the actual state machine rather than re-implementing it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeSocketManager } from '../../extension-cloudflare/background.js';

/** Minimal WebSocket stand-in that records construction and stays controllable. */
class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.closed = null;
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(data);
  }

  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3; // CLOSED
    if (this.onclose) this.onclose({ code, reason });
  }

  /** Simulate the socket opening. */
  open() {
    this.readyState = 1; // OPEN
    if (this.onopen) this.onopen();
  }
}

function makeManager({ instanceId = 'test-instance' } = {}) {
  FakeWebSocket.instances = [];
  const manager = new BridgeSocketManager({
    settings: { workerUrl: 'https://example.test', bridgeToken: 'tok', enforcementMode: 'strict' },
    WebSocketImpl: FakeWebSocket,
    storageApi: null,
    tabsApi: null,
  });
  manager.instanceId = instanceId;
  return { manager, FakeWebSocket };
}

/** Let the mutex drain and any queued async work run. */
const settle = () => new Promise((r) => setImmediate(r));

/**
 * The 15s connection-attempt guard is a real timer. Tests that end while a
 * FakeWebSocket is still CONNECTING leave it armed, and it fires long after
 * the test file finishes, logging reconnects into the next run's output.
 */
function clearAttemptTimer(manager) {
  if (manager._connectionAttemptTimer) {
    clearTimeout(manager._connectionAttemptTimer);
    manager._connectionAttemptTimer = null;
  }
}

/**
 * onopen arms the 180s stale-socket timer. Left armed it fires after the file
 * finishes, closes the fake socket, and cascades through scheduleReconnect()
 * into a long reconnect log that bleeds into the next run.
 */
function clearStaleTimer(manager) {
  if (manager._staleCheckTimer) {
    clearTimeout(manager._staleCheckTimer);
    manager._staleCheckTimer = null;
  }
  if (manager.reconnectTimer) {
    clearTimeout(manager.reconnectTimer);
    manager.reconnectTimer = null;
  }
}

/** Put the manager in the state a failed connect leaves behind. */
function driveToReconnecting(manager) {
  manager._state = 'RECONNECTING';
  manager.reconnectTimer = { _id: 'armed' }; // pending timer, as scheduleReconnect() leaves
}

test('RECONNECTING does not block a new connection attempt', async () => {
  const { manager, FakeWebSocket: WS } = makeManager();
  driveToReconnecting(manager);
  assert.equal(manager._state, 'RECONNECTING', 'precondition: we are waiting on a timer');

  manager.connect();
  await settle();

  assert.equal(
    WS.instances.length,
    1,
    'connect() must actually construct a WebSocket even when RECONNECTING — ' +
      'this is the deadlock: previously zero sockets were created'
  );
  assert.equal(manager._state, 'CONNECTING', 'state must advance out of RECONNECTING');
  clearAttemptTimer(manager);
});

test('starting an attempt from RECONNECTING clears the armed timer', async () => {
  const { manager } = makeManager();
  driveToReconnecting(manager);

  let cleared = null;
  const originalClear = globalThis.clearTimeout;
  globalThis.clearTimeout = (id) => {
    cleared = id;
    return originalClear(id);
  };

  try {
    manager.connect();
    await settle();
  } finally {
    globalThis.clearTimeout = originalClear;
  }

  assert.equal(cleared?._id, 'armed', 'the pending timer must be cleared, not just dereferenced');
  assert.equal(manager.reconnectTimer, null, 'the timer handle must be dropped');
  clearAttemptTimer(manager);
});

test('CONNECTING still blocks a second concurrent attempt', async () => {
  // The guard that actually matters: never stack two sockets while one dials.
  const { manager, FakeWebSocket: WS } = makeManager();

  manager.connect();
  await settle();
  assert.equal(WS.instances.length, 1, 'first attempt started');

  manager._state = 'CONNECTING';
  manager.connect();
  await settle();

  assert.equal(WS.instances.length, 1, 'a second attempt must not start while CONNECTING');
  clearAttemptTimer(manager);
});

test('a successful attempt still reaches CONNECTED from RECONNECTING', async () => {
  const { manager, FakeWebSocket: WS } = makeManager();
  driveToReconnecting(manager);

  manager.connect();
  await settle();

  const socket = WS.instances[0];
  assert.ok(socket, 'a socket was created');
  socket.open();

  assert.equal(manager._state, 'CONNECTED', 'the full RECONNECTING -> CONNECTED path must work');
  clearStaleTimer(manager);
});
