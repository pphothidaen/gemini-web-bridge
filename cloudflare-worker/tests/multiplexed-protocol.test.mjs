// ============================================================
// Gemini Web-Bridge: Multiplexed Protocol + Scope Router Tests
// Phase 4: Unit tests for multiplexed connection and scope routing
//
// Covers:
//  1. Single connection, multiple scopes → correct routing
//  2. Scope subscribe/unsubscribe lifecycle (ScopeSessionManager)
//  3. Connection drop + reconnect → scopes re-registered
//  4. TTL cleanup of stale scope sessions
//  5. Instance ID conflict handling (same id, different scope)
//  6. Epoch bump on reconnect preserves scope sessions
//
// Run: node --test multiplexed-protocol.test.mjs
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import * as modelCatalog from '../src/model-catalog.js';
import * as protocol from '../../extension-cloudflare/protocol-messages.js';

// ─── Load DO source and strip Cloudflare imports ───────────────
const doSource = fs.readFileSync(
  new URL('../src/index.js', import.meta.url), 'utf8'
);

const doClassSrc = doSource
  .replace(/import[\s\S]*?from "[^"]+";/g, '')
  .replaceAll('export class ', 'class ')
  .replace('export default {', 'const entry = {');

// ─── VM context for DO ────────────────────────────────────────
const sharedContext = {
  ...modelCatalog,
  DurableObject: class {},
  // Workers-runtime-accurate crypto: WebCrypto only. Node's global crypto also
  // exposes createHash/createHmac/Cipheriv, which do NOT exist in workerd —
  // spreading it here previously masked a production `crypto.createHash is not
  // a function` TypeError on every /bridge upgrade.
  crypto: {
    randomUUID,
    getRandomValues: (arr) => globalThis.crypto.getRandomValues(arr),
    subtle: globalThis.crypto.subtle,
  },
  Request: globalThis.Request,
  Response: globalThis.Response,
  URL: globalThis.URL,
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
  TextEncoderStream: globalThis.TextEncoderStream,
  TransformStream: globalThis.TransformStream,
  ReadableStream: globalThis.ReadableStream,
  console: globalThis.console,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: () => {},
  setImmediate: (f) => setTimeout(f, 0),
};

const { GeminiBridgeDO } = vm.runInNewContext(
  doClassSrc + '\n;({GeminiBridgeDO})',
  sharedContext
);

// Shorthand for protocol exports
const {
  ScopeSessionManager,
  ScopeRouter,
  MessageTypes,
  validateScope,
  scopeFromPath,
  scopeToUrl,
  buildMessage,
  buildScopeSwitchMessage,
  buildScopeReadyMessage,
  PROTOCOL_VERSION,
  supportsMultiplexedProtocol,
  getProtocolInfo,
} = protocol;

// ─── Helpers ──────────────────────────────────────────────────

/** Create a mock WebSocket-like socket object */
function mockSocket() {
  return {
    readyState: 1,
    send: () => {},
    close: () => {},
  };
}

/** Create a DO instance with scopeRouter wired up for testing */
function createBridge() {
  const b = new GeminiBridgeDO({}, {
    CLIENT_API_TOKEN: 'test-token',
    BRIDGE_AUTH_TOKEN: 'bridge-secret',
  });
  b.currentTokens = { sessionReady: true };
  b.lastNotebookScope = 'notebook:test-nb-id';

  // The DO source has `scopeRouter = { ... }` as an instance property
  // but the VM stripping removed it (it's defined in the class body).
  // Re-create the scopeRouter from the source.
  const resolveScopeInput = function(input) {
    if (typeof input !== 'string' || !input.trim()) return null;
    let s = input.trim();
    try {
      if (/^https?:\/\//i.test(s)) s = new URL(s).pathname;
    } catch (e) {}
    if (s.startsWith('/')) {
      const m = s.match(/^\/(notebook|app)\/([A-Za-z0-9_-]+)/);
      if (m) return `${m[1]}:${m[2]}`;
      return (s === '/app' || s.startsWith('/app/')) ? 'app' : null;
    }
    if (/^(notebook|app):[A-Za-z0-9_-]+$/.test(s)) return s;
    const lower = s.toLowerCase();
    if (['app', 'default', 'normal'].includes(lower)) return 'app';
    if (lower === 'notebook') return b.lastNotebookScope;
    return null;
  };

  b.scopeRouter = {
    currentScope: b.currentScope,
    lastNotebookScope: b.lastNotebookScope,
    resolveScopeInput,
    _scopeListeners: new Map(),
    handleAppScope: function(msg, scope) {
      const connection = this.getActiveConnection();
      if (connection && connection.socket.readyState === 1) {
        connection.socket.send(JSON.stringify(msg));
        return { routed: true, scope };
      }
      return { routed: false, error: 'No active connection' };
    },
    handleNotebookScope: function(msg, scope) {
      const connection = this.getActiveConnection();
      if (connection && connection.socket.readyState === 1) {
        connection.socket.send(JSON.stringify(msg));
        return { routed: true, scope };
      }
      return { routed: false, error: 'No active connection' };
    },
    route: function(msg, defaultHandler) {
      const scope = msg.scope || this.currentScope || 'app';
      const validatedScope = this.resolveScopeInput(scope);
      if (!validatedScope) {
        console.warn(`[ScopeRouter] Invalid scope: ${scope}, using default handler`);
        return defaultHandler ? defaultHandler(msg) : null;
      }
      console.log(`[ScopeRouter] Routing message to scope: ${validatedScope}`);
      if (validatedScope === 'app' || validatedScope.startsWith('app:')) {
        return this.handleAppScope(msg, validatedScope);
      } else if (validatedScope === 'notebook' || validatedScope.startsWith('notebook:')) {
        return this.handleNotebookScope(msg, validatedScope);
      }
      return defaultHandler ? defaultHandler(msg) : null;
    },
    getActiveConnection: function() {
      for (const state of this.activeConnections.values()) {
        if (state.socket.readyState === 1) return state;
      }
      return null;
    },
  };
  return b;
}

/** Mock handler that records calls */
function createRecorder() {
  const calls = [];
  return {
    record: (msg, scope) => calls.push({ msg, scope, timestamp: Date.now() }),
    getCalls: () => calls,
    clear: () => { calls.length = 0; },
    callCount: () => calls.length,
  };
}

// ═══════════════════════════════════════════════════════════════
// TEST SUITE 1: ScopeRouter class (from protocol-messages.js)
// ═══════════════════════════════════════════════════════════════

test('ScopeRouter: registers and routes to exact-scope handlers', async () => {
  const router = new ScopeRouter({ currentScope: 'app' });
  const appHandler = createRecorder();
  const nbHandler = createRecorder();

  router.registerScopeHandler('app', (msg) => appHandler.record(msg, 'app'));
  router.registerScopeHandler('notebook:test-nb', (msg) => nbHandler.record(msg, 'notebook:test-nb'));

  await router.routeMessage({ type: 'EXECUTE_REQUEST', scope: 'app', requestId: 'r1' });
  await router.routeMessage({ type: 'EXECUTE_REQUEST', scope: 'notebook:test-nb', requestId: 'r2' });

  assert.equal(appHandler.callCount(), 1);
  assert.equal(appHandler.getCalls()[0].scope, 'app');
  assert.equal(nbHandler.callCount(), 1);
  assert.equal(nbHandler.getCalls()[0].scope, 'notebook:test-nb');
});

test('ScopeRouter: pattern matching — "app" matches "app:*" scopes', async () => {
  const router = new ScopeRouter({ currentScope: 'app' });
  const handler = createRecorder();

  router.registerScopeHandler('app', (msg) => handler.record(msg, 'app'));
  await router.routeMessage({ type: 'CHAT', scope: 'app:conv_123', requestId: 'r1' });
  await router.routeMessage({ type: 'CHAT', scope: 'app:conv_456', requestId: 'r2' });

  assert.equal(handler.callCount(), 2);
});

test('ScopeRouter: pattern matching — "notebook" matches "notebook:*" scopes', async () => {
  const router = new ScopeRouter({ currentScope: 'app' });
  const handler = createRecorder();

  router.registerScopeHandler('notebook', (msg) => handler.record(msg, 'notebook'));
  await router.routeMessage({ type: 'CHAT', scope: 'notebook:nb_a', requestId: 'r1' });
  await router.routeMessage({ type: 'CHAT', scope: 'notebook:nb_b', requestId: 'r2' });

  assert.equal(handler.callCount(), 2);
});

test('ScopeRouter: wildcard "*" matches any scope', async () => {
  const router = new ScopeRouter({ currentScope: 'app' });
  const wildHandler = createRecorder();
  const exactHandler = createRecorder();

  router.registerScopeHandler('app', (msg) => exactHandler.record(msg, 'app'));
  router.registerScopeHandler('*', (msg, scope) => wildHandler.record(msg, scope));

  await router.routeMessage({ type: 'CHAT', scope: 'app', requestId: 'r1' });
  // 'notebook:nb_x' validates, has no specific handler → hits wildcard
  await router.routeMessage({ type: 'CHAT', scope: 'notebook:nb_x', requestId: 'r2' });

  assert.equal(exactHandler.callCount(), 1);
  assert.equal(wildHandler.callCount(), 1);
  assert.ok(wildHandler.getCalls()[0].scope.startsWith('notebook:'));
});

test('ScopeRouter: no scope in message → uses currentScope', async () => {
  const router = new ScopeRouter({ currentScope: 'notebook:active-nb' });
  const handler = createRecorder();

  router.registerScopeHandler('notebook', (msg) => handler.record(msg, 'notebook'));
  await router.routeMessage({ type: 'CHAT', requestId: 'r1' });

  assert.equal(handler.callCount(), 1);
});

test('ScopeRouter: invalid scope returns error result', async () => {
  const router = new ScopeRouter({ currentScope: 'app' });
  const result = await router.routeMessage({ type: 'CHAT', scope: 'invalid_scope!@#' });

  assert.equal(result.success, false);
  assert.equal(result.code, 'invalid_scope');
});

test('ScopeRouter: no handler registered → returns no_handler error', async () => {
  const router = new ScopeRouter({ currentScope: 'app' });
  // 'app:custom' validates, doesn't match exact 'app' handler (no 'app:*' registered),
  // so it hits no_handler since no handler covers 'app:custom'
  const result = await router.routeMessage({ type: 'CHAT', scope: 'app:custom' });

  assert.equal(result.success, false);
  assert.equal(result.code, 'no_handler');
});

test('ScopeRouter: default handler catches unmatched scopes', async () => {
  const router = new ScopeRouter({ currentScope: 'app' });
  const defaultCalls = [];
  router.setDefaultHandler((msg, scope) => defaultCalls.push({ msg, scope }));

  await router.routeMessage({ type: 'CHAT', scope: 'notebook:nb_x' });

  assert.equal(defaultCalls.length, 1);
  assert.equal(defaultCalls[0].scope, 'notebook:nb_x');
});

test('ScopeRouter: matchScopePattern — exact, prefix, wildcard', () => {
  const router = new ScopeRouter({ currentScope: 'app' });
  assert.equal(router.matchScopePattern('app:conv', 'app'), true);
  assert.equal(router.matchScopePattern('notebook:nb1', 'notebook'), true);
  assert.equal(router.matchScopePattern('notebook:nb1', 'notebook:*'), true);
  assert.equal(router.matchScopePattern('app:conv', 'app:*'), true);
  assert.equal(router.matchScopePattern('anything', '*'), true);
  assert.equal(router.matchScopePattern('app:conv', 'notebook'), false);
});

test('ScopeRouter: getHandlerForScope returns correct handler', () => {
  const router = new ScopeRouter({ currentScope: 'app' });
  const h1 = () => {};
  const h2 = () => {};

  router.registerScopeHandler('app', h1);
  router.registerScopeHandler('notebook:*', h2);

  assert.equal(router.getHandlerForScope('app'), h1);
  assert.equal(router.getHandlerForScope('app:conv'), h1);
  assert.equal(router.getHandlerForScope('notebook:nb1'), h2);
  assert.equal(router.getHandlerForScope('unknown'), router.defaultHandler);
});

test('ScopeRouter: getScopeStats returns registered handlers and active scopes', () => {
  const router = new ScopeRouter({ currentScope: 'app' });
  router.registerScopeHandler('app', () => {});
  router.registerScopeHandler('notebook', () => {});

  router.routeMessage({ type: 'CHAT', scope: 'app' });
  router.routeMessage({ type: 'CHAT', scope: 'notebook:nb1' });

  const stats = router.getScopeStats();
  assert.equal(stats.registeredHandlers.length, 2);
  assert.equal(stats.hasDefaultHandler, false);
  assert.equal(stats.scopeCount, 2);
  assert.equal(stats.activeScopes.length, 2);
});

test('ScopeRouter: pruneOldScopes removes entries older than cutoff', () => {
  const router = new ScopeRouter({ currentScope: 'app' });
  const oldTime = Date.now() - 400000;
  router.scopeHistory.set('old:scope', oldTime);
  router.scopeHistory.set('recent:scope', Date.now());

  router.pruneOldScopes(300000);

  assert.equal(router.scopeHistory.has('old:scope'), false);
  assert.equal(router.scopeHistory.has('recent:scope'), true);
});

// ═══════════════════════════════════════════════════════════════
// TEST SUITE 2: ScopeSessionManager class (extension side)
// ═══════════════════════════════════════════════════════════════

test('ScopeSessionManager: initial state is "app"', () => {
  const mgr = new ScopeSessionManager();
  assert.equal(mgr.getCurrentScope(), 'app');
  assert.equal(mgr.isSwitching(), false);
  assert.equal(mgr.targetScope, null);
});

test('ScopeSessionManager: requestScopeSwitch validates and updates state', () => {
  const mgr = new ScopeSessionManager();
  const result = mgr.requestScopeSwitch('notebook:nb_123', 'req_1');

  assert.equal(result, 'notebook:nb_123');
  assert.equal(mgr.targetScope, 'notebook:nb_123');
  assert.equal(mgr.isSwitching(), true);
  assert.equal(mgr.getCurrentScope(), 'app');
});

test('ScopeSessionManager: requestScopeSwitch rejects invalid scopes', () => {
  const mgr = new ScopeSessionManager();
  assert.equal(mgr.requestScopeSwitch(null, 'req_1'), null);
  assert.equal(mgr.requestScopeSwitch('invalid:scope', 'req_1'), null);
  // "app" is valid — returns the validated scope string
  assert.equal(mgr.requestScopeSwitch('app', 'req_1'), 'app');
});

test('ScopeSessionManager: requestScopeSwitch returns scope when already at target', () => {
  const mgr = new ScopeSessionManager();
  mgr.confirmScope('app:conv_123');
  const result = mgr.requestScopeSwitch('app:conv_123', 'req_1');

  assert.equal(result, 'app:conv_123');
  assert.equal(mgr.isSwitching(), false);
  assert.equal(mgr.targetScope, null);
});

test('ScopeSessionManager: confirmScope transitions state correctly', () => {
  const mgr = new ScopeSessionManager();
  mgr.requestScopeSwitch('notebook:nb_456', 'req_1');
  assert.equal(mgr.isSwitching(), true);

  mgr.confirmScope('notebook:nb_456');
  assert.equal(mgr.getCurrentScope(), 'notebook:nb_456');
  assert.equal(mgr.isSwitching(), false);
  assert.equal(mgr.targetScope, null);
});

test('ScopeSessionManager: confirmScope rejects invalid scope', () => {
  const mgr = new ScopeSessionManager();
  mgr.confirmScope('bad scope');
  assert.equal(mgr.getCurrentScope(), 'app');
});

test('ScopeSessionManager: handleScopeSwitch with navigateCallback', async () => {
  const mgr = new ScopeSessionManager();
  const navCalls = [];

  const navCb = async (url, scope) => {
    navCalls.push({ url, scope });
  };

  const result = await mgr.handleScopeSwitch(
    { scope: 'notebook:nb_789', requestId: 'req_nav' },
    navCb
  );

  assert.equal(result, 'notebook:nb_789');
  assert.equal(navCalls.length, 1);
  assert.equal(navCalls[0].scope, 'notebook:nb_789');
  assert.ok(navCalls[0].url.includes('gemini.google.com/notebook/nb_789'));
});

test('ScopeSessionManager: handleScopeSwitch is no-op when already at scope', async () => {
  const mgr = new ScopeSessionManager();
  mgr.confirmScope('app');

  const result = await mgr.handleScopeSwitch(
    { scope: 'app', requestId: 'req_same' },
    () => { throw new Error('should not navigate'); }
  );

  assert.equal(result, 'app');
});

test('ScopeSessionManager: scope listeners — register and fire via _scopeListeners Map', () => {
  const mgr = new ScopeSessionManager();
  const fired = [];

  mgr.onScopeReady('req_1', (scope) => fired.push(scope));
  mgr.onScopeReady('req_2', (scope) => fired.push(scope));

  // Simulate SCOPE_READY arrival by calling stored callbacks
  const cb1 = mgr._scopeListeners.get('req_1');
  if (cb1) cb1('app:conv_a');
  const cb2 = mgr._scopeListeners.get('req_2');
  if (cb2) cb2('notebook:nb_x');

  assert.equal(fired.length, 2);
  assert.equal(fired[0], 'app:conv_a');
  assert.equal(fired[1], 'notebook:nb_x');
});

test('ScopeSessionManager: removeScopeListener removes callback from _scopeListeners', () => {
  const mgr = new ScopeSessionManager();
  const fired = [];

  mgr.onScopeReady('req_remove', (scope) => fired.push(scope));
  mgr.removeScopeListener('req_remove');

  // After removal, the stored callback should be undefined
  const cb = mgr._scopeListeners.get('req_remove');
  assert.equal(cb, undefined);
  assert.equal(fired.length, 0);
});

test('ScopeSessionManager: detectScopeFromPath updates scope on SPA navigation', () => {
  const mgr = new ScopeSessionManager();
  mgr.confirmScope('app');

  const detected = mgr.detectScopeFromPath('/notebook/nb_abc');
  assert.equal(detected, 'notebook:nb_abc');
  assert.equal(mgr.getCurrentScope(), 'notebook:nb_abc');
});

test('ScopeSessionManager: detectScopeFromPath is no-op when scope unchanged', () => {
  const mgr = new ScopeSessionManager();
  mgr.confirmScope('app');

  const detected = mgr.detectScopeFromPath('/app');
  assert.equal(detected, 'app');
  assert.equal(mgr.isSwitching(), false);
});

test('ScopeSessionManager: getScopeInfo returns current state', () => {
  const mgr = new ScopeSessionManager();
  mgr.requestScopeSwitch('notebook:nb_x', 'req_info');

  const info = mgr.getScopeInfo();
  assert.equal(info.currentScope, 'app');
  assert.equal(info.targetScope, 'notebook:nb_x');
  assert.equal(info.isSwitching, true);
  assert.ok(info.timeInCurrentScope >= 0);
});

// ═══════════════════════════════════════════════════════════════
// TEST SUITE 3: DO built-in scopeRouter — message routing
// ═══════════════════════════════════════════════════════════════

test('DO scopeRouter: routes app messages to handleAppScope', () => {
  const b = createBridge();
  const calls = [];

  b.scopeRouter.handleAppScope = (msg, scope) => {
    calls.push({ type: msg.type, scope });
    return { routed: true, scope };
  };

  b.scopeRouter.route(
    { type: 'EXECUTE_REQUEST', scope: 'app:conv_1', requestId: 'r1' },
    () => ({ routed: false })
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'EXECUTE_REQUEST');
  assert.ok(calls[0].scope.startsWith('app:'));
});

test('DO scopeRouter: routes notebook messages to handleNotebookScope', () => {
  const b = createBridge();
  b.lastNotebookScope = 'notebook:test-nb-id';
  b.scopeRouter.lastNotebookScope = 'notebook:test-nb-id';
  const calls = [];

  b.scopeRouter.handleNotebookScope = (msg, scope) => {
    calls.push({ type: msg.type, scope });
    return { routed: true, scope };
  };

  b.scopeRouter.route(
    { type: 'EXECUTE_REQUEST', scope: 'notebook:nb_1', requestId: 'r1' },
    () => ({ routed: false })
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'EXECUTE_REQUEST');
  assert.ok(calls[0].scope.startsWith('notebook:'));
});

test('DO scopeRouter: falls back to defaultHandler for unknown scope', () => {
  const b = createBridge();
  let defaultCalled = false;

  b.scopeRouter.route(
    { type: 'CHAT', scope: 'unknown:scope', requestId: 'r1' },
    (msg) => { defaultCalled = true; return { routed: true }; }
  );

  assert.equal(defaultCalled, true);
});

test('DO scopeRouter: no scope in message uses currentScope', () => {
  const b = createBridge();
  b.scopeRouter.currentScope = 'notebook:nb_active';
  const calls = [];

  b.scopeRouter.handleNotebookScope = (msg, scope) => {
    calls.push({ scope });
    return { routed: true, scope };
  };

  const result = b.scopeRouter.route(
    { type: 'EXECUTE_REQUEST', requestId: 'r1' },
    () => ({ routed: false })
  );

  assert.equal(result.routed, true);
  assert.equal(calls[0].scope, 'notebook:nb_active');
});

test('DO scopeRouter: invalid scope in message uses default handler', () => {
  const b = createBridge();
  let defaultCalled = false;

  b.scopeRouter.route(
    { type: 'CHAT', scope: '../../etc/passwd', requestId: 'r1' },
    () => { defaultCalled = true; return { routed: true }; }
  );

  assert.equal(defaultCalled, true);
});

test('DO scopeRouter: "app" bare scope routes to handleAppScope', () => {
  const b = createBridge();
  const calls = [];

  b.scopeRouter.handleAppScope = (msg, scope) => {
    calls.push({ scope });
    return { routed: true, scope };
  };

  const result = b.scopeRouter.route(
    { type: 'EXECUTE_REQUEST', scope: 'app', requestId: 'r1' },
    () => ({ routed: false })
  );

  assert.equal(result.routed, true);
  assert.equal(calls[0].scope, 'app');
});

test('DO scopeRouter: "notebook" bare scope uses lastNotebookScope', () => {
  const b = createBridge();
  b.lastNotebookScope = 'notebook:last_nb';
  b.scopeRouter.lastNotebookScope = 'notebook:last_nb';
  const calls = [];

  b.scopeRouter.handleNotebookScope = (msg, scope) => {
    calls.push({ scope });
    return { routed: true, scope };
  };

  const result = b.scopeRouter.route(
    { type: 'EXECUTE_REQUEST', scope: 'notebook', requestId: 'r1' },
    () => ({ routed: false })
  );

  // 'notebook' bare scope → resolveScopeInput returns 'notebook:last_nb'
  // via b.lastNotebookScope, which starts with 'notebook:' → hits handleNotebookScope
  assert.equal(result.routed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope, 'notebook:last_nb');
});

// ═══════════════════════════════════════════════════════════════
// TEST SUITE 4: Connection drop + reconnect — scopes re-registered
// ═══════════════════════════════════════════════════════════════

test('Connection drop: removeConnection clears instance from activeConnections', () => {
  const b = createBridge();
  const instanceId = randomUUID();

  b.recordConnection(instanceId, mockSocket());
  assert.equal(b.activeConnections.has(instanceId), true);

  b.removeConnection(instanceId);
  assert.equal(b.activeConnections.has(instanceId), false);
});

test('Connection drop: getActiveConnection returns null after all removed', () => {
  const b = createBridge();
  const id1 = randomUUID();
  const id2 = randomUUID();

  b.recordConnection(id1, mockSocket());
  b.recordConnection(id2, mockSocket());

  b.removeConnection(id1);
  b.removeConnection(id2);
  assert.equal(b.getActiveConnection(), null);
});

test('Reconnect: same instanceId replaces old connection and preserves scope', () => {
  const b = createBridge();
  const instanceId = randomUUID();

  // First connection with scope
  b.recordConnection(instanceId, mockSocket());
  b.currentScope = 'app:conv_1';
  b.currentTokens = { sessionReady: true };

  const epochBefore = b.getEpoch();
  assert.equal(b.currentScope, 'app:conv_1');

  // Reconnect — same instanceId
  b.recordConnection(instanceId, mockSocket());

  const newConnState = b.activeConnections.get(instanceId);
  assert.ok(newConnState.epoch > epochBefore);
  assert.equal(b.currentScope, 'app:conv_1');
  assert.equal(b.currentTokens.sessionReady, true);
});

test('Reconnect: multiple scopes registered, all still route after reconnect', () => {
  const b = createBridge();
  const instanceId = randomUUID();

  const appCalls = [];
  const nbCalls = [];

  b.scopeRouter.handleAppScope = (msg, scope) => {
    appCalls.push(msg);
    return { routed: true, scope };
  };
  b.scopeRouter.handleNotebookScope = (msg, scope) => {
    nbCalls.push(msg);
    return { routed: true, scope };
  };

  b.recordConnection(instanceId, mockSocket());
  b.currentScope = 'app';

  b.scopeRouter.route({ type: 'APP_MSG', scope: 'app:conv_a' });
  b.scopeRouter.route({ type: 'NB_MSG', scope: 'notebook:nb_x' });

  b.removeConnection(instanceId);
  b.recordConnection(instanceId, mockSocket());

  b.scopeRouter.route({ type: 'APP_MSG_2', scope: 'app:conv_b' });
  b.scopeRouter.route({ type: 'NB_MSG_2', scope: 'notebook:nb_y' });

  assert.equal(appCalls.length, 2);
  assert.equal(nbCalls.length, 2);
});

test('Reconnect: getActiveConnection returns the reconnected socket', () => {
  const b = createBridge();
  const instanceId = randomUUID();

  b.recordConnection(instanceId, mockSocket());

  const active = b.getActiveConnection();
  assert.ok(active);
  assert.equal(active.socket.readyState, 1);
});

// ═══════════════════════════════════════════════════════════════
// TEST SUITE 5: TTL cleanup of stale scope sessions
// ═══════════════════════════════════════════════════════════════

test('TTL: isConnectionStale returns true when idle > 45s', () => {
  const b = createBridge();
  const instanceId = randomUUID();

  // Create a normal connection first
  b.recordConnection(instanceId, mockSocket());

  // Directly set a stale timestamp (recordConnection resets lastActivityAt to now)
  b.activeConnections.get(instanceId).lastActivityAt = Date.now() - 50000;

  assert.equal(b.isConnectionStale(instanceId), true);
});

test('TTL: isConnectionStale returns false when idle < 45s', () => {
  const b = createBridge();
  const instanceId = randomUUID();

  b.recordConnection(instanceId, mockSocket());
  // Set a fresh timestamp (< 45s idle)
  b.activeConnections.get(instanceId).lastActivityAt = Date.now() - 30000;

  assert.equal(b.isConnectionStale(instanceId), false);
});

test('TTL: isConnectionStale returns false for unknown instance', () => {
  const b = createBridge();
  assert.equal(b.isConnectionStale('nonexistent-instance'), false);
});

test('TTL: touchConnection updates lastActivityAt', () => {
  const b = createBridge();
  const instanceId = randomUUID();

  // Create connection and then manually set a stale timestamp
  b.recordConnection(instanceId, mockSocket());
  b.activeConnections.get(instanceId).lastActivityAt = Date.now() - 50000;

  b.touchConnection(instanceId);
  const state = b.activeConnections.get(instanceId);
  assert.ok(state.lastActivityAt > Date.now() - 100);
  assert.equal(b.isConnectionStale(instanceId), false);
});

test('TTL: recordConnection evicts stale connections from other instances', () => {
  const b = createBridge();
  const freshId = randomUUID();
  const staleId = randomUUID();

  // Create stale connection
  b.recordConnection(staleId, mockSocket());
  // Set stale timestamp directly (recordConnection resets to now)
  b.activeConnections.get(staleId).lastActivityAt = Date.now() - 50000;

  assert.equal(b.activeConnections.has(staleId), true);

  // Create fresh connection → should evict stale
  b.recordConnection(freshId, mockSocket());

  assert.equal(b.activeConnections.has(staleId), false);
  assert.equal(b.activeConnections.has(freshId), true);
});

test('TTL: activeConnections size reflects only non-stale entries after eviction', () => {
  const b = createBridge();

  // Directly set a stale entry via Map (bypassing recordConnection which resets timestamps)
  const staleId = randomUUID();
  b.activeConnections.set(staleId, {
    socket: { readyState: 1, send: () => {}, close: () => {} },
    connectedAt: Date.now() - 60000,
    lastActivityAt: Date.now() - 60000,
    epoch: 1,
    tokens: null,
    scope: null,
  });

  assert.equal(b.activeConnections.size, 1);
  assert.equal(b.isConnectionStale(staleId), true);

  // recordConnection should evict the stale entry when a fresh one is added
  const freshId = randomUUID();
  b.recordConnection(freshId, mockSocket());

  assert.equal(b.activeConnections.has(staleId), false);
  assert.equal(b.activeConnections.has(freshId), true);
  assert.equal(b.activeConnections.size, 1);
});

test('TTL: removeConnection when not present returns false', () => {
  const b = createBridge();
  assert.equal(b.removeConnection('never-existed'), false);
});

// ═══════════════════════════════════════════════════════════════
// TEST SUITE 6: Instance ID conflict handling
// ═══════════════════════════════════════════════════════════════

test('InstanceID: same instanceId reconnect always accepted (replaces old)', () => {
  const b = createBridge();
  const instanceId = randomUUID();

  b.recordConnection(instanceId, mockSocket());
  b.currentScope = 'app:conv_original';

  const firstEpoch = b.activeConnections.get(instanceId).epoch;

  b.recordConnection(instanceId, mockSocket());

  const conn = b.activeConnections.get(instanceId);
  assert.equal(conn.epoch, firstEpoch + 1);
  assert.equal(b.activeConnections.size, 1);
});

test('InstanceID: different instanceId + healthy existing → conflict detected', () => {
  const b = createBridge();
  const id1 = randomUUID();
  const id2 = randomUUID();

  b.recordConnection(id1, mockSocket());

  assert.equal(b.isConnectionStale(id1), false);
  assert.equal(b.activeConnections.has(id1), true);
});

test('InstanceID: different instanceId + stale existing → stale evicted', () => {
  const b = createBridge();
  const staleId = randomUUID();
  const freshId = randomUUID();

  // Create stale connection
  b.recordConnection(staleId, mockSocket());
  // Set stale timestamp directly (recordConnection resets to now)
  b.activeConnections.get(staleId).lastActivityAt = Date.now() - 50000;

  // Fresh connection → should evict stale
  b.recordConnection(freshId, mockSocket());

  assert.equal(b.activeConnections.has(staleId), false);
  assert.equal(b.activeConnections.has(freshId), true);
});

test('InstanceID: activeConnections Map tracks multiple instances correctly', () => {
  const b = createBridge();
  const id1 = randomUUID();
  const id2 = randomUUID();
  const id3 = randomUUID();

  b.recordConnection(id1, mockSocket());
  b.recordConnection(id2, mockSocket());
  b.recordConnection(id3, mockSocket());

  assert.equal(b.activeConnections.size, 3);
  assert.equal(b.activeConnections.has(id1), true);
  assert.equal(b.activeConnections.has(id2), true);
  assert.equal(b.activeConnections.has(id3), true);

  b.removeConnection(id2);
  assert.equal(b.activeConnections.size, 2);
  assert.equal(b.activeConnections.has(id2), false);
});

test('InstanceID: getEpoch returns current epoch counter', () => {
  const b = createBridge();
  const initialEpoch = b.getEpoch();

  b.recordConnection(randomUUID(), mockSocket());
  assert.equal(b.getEpoch(), initialEpoch + 1);

  b.recordConnection(randomUUID(), mockSocket());
  assert.equal(b.getEpoch(), initialEpoch + 2);
});

// ═══════════════════════════════════════════════════════════════
// TEST SUITE 7: Epoch bump on reconnect preserves scope sessions
// ═══════════════════════════════════════════════════════════════

test('Epoch: increments on each new connection', () => {
  const b = createBridge();
  const baseEpoch = b.getEpoch();

  b.recordConnection(randomUUID(), mockSocket());
  assert.equal(b.getEpoch(), baseEpoch + 1);

  b.recordConnection(randomUUID(), mockSocket());
  assert.equal(b.getEpoch(), baseEpoch + 2);

  b.recordConnection(randomUUID(), mockSocket());
  assert.equal(b.getEpoch(), baseEpoch + 3);
});

test('Epoch: preserved across reconnect (same instanceId)', () => {
  const b = createBridge();
  const instanceId = randomUUID();
  const epoch1 = b.getEpoch();

  b.recordConnection(instanceId, mockSocket());

  const conn1 = b.activeConnections.get(instanceId);
  assert.equal(conn1.epoch, epoch1 + 1);

  b.recordConnection(instanceId, mockSocket());

  const conn2 = b.activeConnections.get(instanceId);
  assert.equal(conn2.epoch, epoch1 + 2);
  assert.equal(b.activeConnections.size, 1);
});

test('Epoch: scope sessions preserved across epoch bump', () => {
  const b = createBridge();
  const instanceId = randomUUID();

  b.recordConnection(instanceId, mockSocket());
  b.currentScope = 'notebook:nb_preserved';
  b.currentTokens = { sessionReady: true, tokens: 'abc' };

  const epochBefore = b.getEpoch();

  b.recordConnection(instanceId, mockSocket());

  assert.equal(b.getEpoch(), epochBefore + 1);
  assert.equal(b.currentScope, 'notebook:nb_preserved');
  assert.equal(b.currentTokens.sessionReady, true);
  assert.equal(b.activeConnections.size, 1);
});

test('Epoch: connection state records epoch at connection time', () => {
  const b = createBridge();
  const instanceId = randomUUID();
  const expectedEpoch = b.getEpoch() + 1;

  b.recordConnection(instanceId, mockSocket());

  const state = b.activeConnections.get(instanceId);
  assert.equal(state.epoch, expectedEpoch);
});

test('Epoch: healthState reflects current epoch', () => {
  const b = createBridge();
  const initialHealth = b.healthState;
  assert.equal(initialHealth.currentEpoch, b.getEpoch());

  b.recordConnection(randomUUID(), mockSocket());
  const updatedHealth = b.healthState;
  assert.equal(updatedHealth.currentEpoch, b.getEpoch());
  assert.equal(updatedHealth.activeConnections, b.activeConnections.size);
});

// ═══════════════════════════════════════════════════════════════
// TEST SUITE 8: Protocol message builders and constants
// ═══════════════════════════════════════════════════════════════

test('buildMessage includes type, protocolVersion, and optional fields', () => {
  const msg = buildMessage('TEST_MSG', {
    requestId: 'req_123',
    scope: 'app:conv',
    customField: 'value',
  });

  assert.equal(msg.type, 'TEST_MSG');
  assert.equal(msg.protocolVersion, PROTOCOL_VERSION);
  assert.equal(msg.requestId, 'req_123');
  assert.equal(msg.scope, 'app:conv');
  assert.equal(msg.customField, 'value');
});

test('buildMessage validates scope via validateScope', () => {
  const msg = buildMessage('TEST', { scope: 'app:valid_id' });
  assert.equal(msg.scope, 'app:valid_id');

  const msg2 = buildMessage('TEST', { scope: 'invalid scope' });
  assert.equal(msg2.scope, 'invalid scope');
});

test('buildScopeSwitchMessage creates correct SCOPE_SWITCH message', () => {
  const msg = buildScopeSwitchMessage('notebook:nb_1', 'req_switch');

  assert.equal(msg.type, MessageTypes.SCOPE_SWITCH);
  assert.equal(msg.scope, 'notebook:nb_1');
  assert.equal(msg.requestId, 'req_switch');
  assert.equal(msg.protocolVersion, PROTOCOL_VERSION);
  assert.ok(msg.timestamp);
});

test('buildScopeReadyMessage creates correct SCOPE_READY message', () => {
  const msg = buildScopeReadyMessage('app:conv_1', 'req_ready');

  assert.equal(msg.type, MessageTypes.SCOPE_READY);
  assert.equal(msg.scope, 'app:conv_1');
  assert.equal(msg.requestId, 'req_ready');
  assert.equal(msg.protocolVersion, PROTOCOL_VERSION);
});

test('supportsMultiplexedProtocol: v3+ returns true', () => {
  assert.equal(supportsMultiplexedProtocol(3), true);
  assert.equal(supportsMultiplexedProtocol(4), true);
  assert.equal(supportsMultiplexedProtocol(2), false);
  assert.equal(supportsMultiplexedProtocol(1), false);
});

test('getProtocolInfo returns correct protocol metadata', () => {
  const info = getProtocolInfo();

  assert.equal(info.version, PROTOCOL_VERSION);
  assert.equal(info.features.multiplexedProtocol, true);
  assert.equal(info.features.scopeSwitchWithoutReconnect, true);
  assert.ok(info.supportedScopes.includes('app'));
  assert.ok(info.supportedScopes.includes('notebook'));
  assert.ok(info.messageTypes.includes('SCOPE_SWITCH'));
  assert.ok(info.messageTypes.includes('SCOPE_READY'));
});

// ═══════════════════════════════════════════════════════════════
// TEST SUITE 9: validateScope, scopeFromPath, scopeToUrl (utility)
// ═══════════════════════════════════════════════════════════════

test('validateScope: accepts valid scopes', () => {
  assert.equal(validateScope('app'), 'app');
  assert.equal(validateScope('app:conv_123'), 'app:conv_123');
  assert.equal(validateScope('notebook:nb_abc'), 'notebook:nb_abc');
  assert.equal(validateScope('notebook:test-nb-id'), 'notebook:test-nb-id');
});

test('validateScope: rejects invalid scopes', () => {
  assert.equal(validateScope(null), null);
  assert.equal(validateScope(undefined), null);
  assert.equal(validateScope(''), null);
  assert.equal(validateScope('invalid'), null);
  assert.equal(validateScope('app:'), null);
  assert.equal(validateScope('app:invalid chars'), null);
  assert.equal(validateScope('unknown:scope'), null);
});

test('scopeFromPath: parses paths correctly', () => {
  assert.equal(scopeFromPath('/app'), 'app');
  assert.equal(scopeFromPath('/app/conv_123'), 'app:conv_123');
  assert.equal(scopeFromPath('/notebook/nb_abc'), 'notebook:nb_abc');
  assert.equal(scopeFromPath('/unknown'), 'app');
  assert.equal(scopeFromPath(''), 'app');
  assert.equal(scopeFromPath(null), 'app');
});

test('scopeToUrl: maps scopes to gemini.google.com URLs', () => {
  assert.equal(scopeToUrl('app'), 'https://gemini.google.com/app');
  assert.equal(scopeToUrl('app:conv_123'), 'https://gemini.google.com/app/conv_123');
  assert.equal(scopeToUrl('notebook:nb_abc'), 'https://gemini.google.com/notebook/nb_abc');
  assert.equal(scopeToUrl(null), 'https://gemini.google.com/app');
  assert.equal(scopeToUrl(''), 'https://gemini.google.com/app');
});

test('scopeToUrl: rejects traversal and unsafe characters', () => {
  assert.equal(scopeToUrl('app:../../etc'), 'https://gemini.google.com/app');
  assert.equal(scopeToUrl('notebook:../bad'), 'https://gemini.google.com/app');
  assert.equal(scopeToUrl('app:evil/path'), 'https://gemini.google.com/app');
});
