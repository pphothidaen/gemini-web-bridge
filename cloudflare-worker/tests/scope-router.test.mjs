// ScopeRouter unit tests — exercises envelope parsing, lifecycle, routing,
// and cleanup without the full DurableObject/VM harness.
//
// The GeminiBridgeDO source is loaded via vm in the same style as the
// existing test suite (see tests/scope-switching.test.mjs), but here we
// focus specifically on Phase 4 ScopeRouter behaviour.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const source = fs.readFileSync(
  new URL('../src/index.js', import.meta.url),
  'utf8'
);

// Minimal context: we only need DurableObject (stub), crypto, console,
// setTimeout/clearTimeout, and the model-catalog exports for resolveScopeInput.
const catalog = await import('../src/model-catalog.js');

const context = {
  ...catalog,
  DurableObject: class DurableObjectStub {
    constructor() {}
    getActiveConnection() { return null; }
    getEpoch() { return 0; }
    resetModelCatalog() {}
  },
  crypto,
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => {},
};

// Strip top-level imports and export markers, then extract GeminiBridgeDO.
const stripped = source
  .replace(/import[\s\S]*?from "[^"]+";?/g, '')
  .replace(/export\s+class\s+/g, 'class ')
  .replace(/export\s+const\s+/g, 'const ')
  .replace(/export\s+default\s+/g, 'const entry = ')
  .replace(/\bexport\s+/g, '');

const result = vm.runInNewContext(`${stripped}\n({GeminiBridgeDO, ProtocolDecoder})`, context);
const GeminiBridgeDO = result.GeminiBridgeDO;

// Helper: create a bare DO instance wired up enough for ScopeRouter methods.
// We use Object.create to bypass the constructor (which needs env.GEMINI_API_KEY
// and other globals in the VM context) and manually initialize only the
// ScopeRouter fields. resolveScopeInput is bound from the prototype.
function createBridge() {
  const b = Object.create(GeminiBridgeDO.prototype);
  b.scopeSessions = new Map();
  b.connectionOwner = new Map();
  b.scopeHandlers = new Map();
  b.defaultHandler = null;
  b.scopeLastActivity = new Map();
  b._connectionSeq = 0;
  b.resolveScopeInput = GeminiBridgeDO.prototype.resolveScopeInput.bind(b);

  b.registerScopeHandler('app', (envelope, session) => ({
    result: { routed: true, scope: session.scopeId, via: 'app-handler' },
  }));
  b.registerScopeHandler('app:*', (envelope, session) =>
    b.scopeHandlers.get('app')(envelope, session));
  b.registerScopeHandler('notebook', (envelope, session) => ({
    result: { routed: true, scope: session.scopeId, via: 'notebook-handler' },
  }));
  b.registerScopeHandler('notebook:*', (envelope, session) =>
    b.scopeHandlers.get('notebook')(envelope, session));
  return b;
}

// ---------- helpers ----------

function validEnvelope(overrides = {}) {
  return {
    jsonrpc: '2.0',
    id: 'req-1',
    scope_id: 'app:c_123',
    instance_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    method: 'chat.complete',
    params: { messages: [{ role: 'user', content: 'hello' }] },
    scope_session_id: 'sess-1',
    ...overrides,
  };
}

function connId() {
  return 'conn-' + crypto.randomUUID().slice(0, 8);
}

// ---------- tests ----------

test('ScopeRouter: parseEnvelope accepts a well-formed v2 envelope', () => {
  const b = createBridge();
  const env = validEnvelope();
  const parsed = b.parseEnvelope(env);
  assert.equal(parsed.jsonrpc, '2.0');
  assert.equal(parsed.scope_id, 'app:c_123');
  assert.equal(parsed.instance_id, env.instance_id);
  assert.equal(parsed.method, 'chat.complete');
  assert.deepEqual(parsed.params, env.params);
  assert.equal(parsed.scope_session_id, 'sess-1');
  assert.equal(parsed.id, 'req-1');
});

test('ScopeRouter: parseEnvelope rejects missing jsonrpc', () => {
  const b = createBridge();
  assert.throws(
    () => b.parseEnvelope({ scope_id: 'app:x', instance_id: 'x', method: 'm' }),
    /Unsupported jsonrpc/
  );
});

test('ScopeRouter: parseEnvelope rejects missing scope_id', () => {
  const b = createBridge();
  assert.throws(
    () => b.parseEnvelope({ jsonrpc: '2.0', instance_id: 'x', method: 'm' }),
    /Missing or invalid scope_id/
  );
});

test('ScopeRouter: parseEnvelope rejects missing instance_id', () => {
  const b = createBridge();
  assert.throws(
    () => b.parseEnvelope({ jsonrpc: '2.0', scope_id: 'app:x', method: 'm' }),
    /Missing or invalid instance_id/
  );
});

test('ScopeRouter: parseEnvelope rejects missing method', () => {
  const b = createBridge();
  assert.throws(
    () => b.parseEnvelope({ jsonrpc: '2.0', scope_id: 'app:x', instance_id: 'x' }),
    /Missing or invalid method/
  );
});

test('ScopeRouter: parseEnvelope normalizes scope_id via resolveScopeInput', () => {
  const b = createBridge();
  const env = validEnvelope({ scope_id: '/app/c_456' });
  const parsed = b.parseEnvelope(env);
  assert.equal(parsed.scope_id, 'app:c_456');
});

test('ScopeRouter: parseEnvelope rejects unknown scope when no * handler', () => {
  const b = createBridge();
  // Remove the catch-all if any
  b.scopeHandlers.delete('*');
  assert.throws(
    () => b.parseEnvelope(validEnvelope({ scope_id: 'bogus:123' })),
    /Unknown scope_id/
  );
});

test('ScopeRouter: parseEnvelope allows unknown scope when * handler is registered', () => {
  const b = createBridge();
  let starHit = false;
  b.registerScopeHandler('*', () => { starHit = true; });
  // Should not throw
  const parsed = b.parseEnvelope(validEnvelope({ scope_id: 'bogus:123' }));
  assert.equal(parsed.scope_id, 'bogus:123');
});

test('ScopeRouter: buildEnvelope assembles an outbound envelope', () => {
  const b = createBridge();
  const out = b.buildEnvelope({
    id: 'r1',
    scope_id: 'app:c_1',
    scope_session_id: 's1',
    result: { ok: true },
  });
  assert.equal(out.jsonrpc, '2.0');
  assert.equal(out.id, 'r1');
  assert.equal(out.scope_id, 'app:c_1');
  assert.equal(out.scope_session_id, 's1');
  assert.deepEqual(out.result, { ok: true });
  assert.equal(out.error, undefined);
});

test('ScopeRouter: buildEnvelope prefers error over result', () => {
  const b = createBridge();
  const out = b.buildEnvelope({
    id: 'r1',
    scope_id: 'app:c_1',
    result: { ok: true },
    error: { code: -32000, message: 'boom' },
  });
  assert.equal(out.error.code, -32000);
  assert.equal(out.result, undefined);
});

test('ScopeRouter: subscribeScope creates a new session', () => {
  const b = createBridge();
  const c = connId();
  const session = b.subscribeScope(c, 'app:c_1', { params: { foo: 1 } });
  assert.equal(session.scopeId, 'app:c_1');
  assert.ok(session.sessionId);
  assert.equal(session.connId, c);
  assert.equal(session.params.foo, 1);
  assert.equal(b.scopeSessions.get(c).size, 1);
  assert.equal(b.connectionOwner.get('app:c_1'), c);
});

test('ScopeRouter: subscribeScope reuses existing session when re-subscribing', () => {
  const b = createBridge();
  const c = connId();
  const s1 = b.subscribeScope(c, 'app:c_1', { sessionId: 'client-sess' });
  const s2 = b.subscribeScope(c, 'app:c_1', { params: { bar: 2 } });
  assert.equal(s1, s2); // same object
  assert.equal(s2.params.bar, 2); // params updated
  assert.equal(b.scopeSessions.get(c).size, 1);
});

test('ScopeRouter: subscribeScope throws on invalid scope_id', () => {
  const b = createBridge();
  assert.throws(
    () => b.subscribeScope(connId(), '../../etc/passwd'),
    /Invalid scope_id/
  );
});

test('ScopeRouter: unsubscribeScope removes the session and fires hook', () => {
  const b = createBridge();
  const c = connId();
  let unsubscribedSession = null;
  b.subscribeScope(c, 'app:c_1', {}).onUnsubscribe = (s) => {
    unsubscribedSession = s;
  };
  const removed = b.unsubscribeScope(c, 'app:c_1');
  assert.ok(removed);
  assert.equal(unsubscribedSession, removed);
  assert.equal(b.scopeSessions.get(c), undefined);
  assert.equal(b.connectionOwner.get('app:c_1'), undefined);
});

test('ScopeRouter: unsubscribeScope returns null when not subscribed', () => {
  const b = createBridge();
  assert.equal(b.unsubscribeScope(connId(), 'app:x'), null);
});

test('ScopeRouter: getSession returns null when not subscribed', () => {
  const b = createBridge();
  assert.equal(b.getSession(connId(), 'app:x'), null);
});

test('ScopeRouter: getSession returns the session when subscribed', () => {
  const b = createBridge();
  const c = connId();
  const s = b.subscribeScope(c, 'app:c_1');
  assert.equal(b.getSession(c, 'app:c_1'), s);
  assert.equal(b.getSession(c, 'app:c_1', ), s);
});

test('ScopeRouter: routeEnvelope subscribe returns session info', async () => {
  const b = createBridge();
  const c = connId();
  const env = validEnvelope({ method: 'subscribe', scope_id: 'app:c_1' });
  const res = await b.routeEnvelope(env, c);
  assert.equal(res.jsonrpc, '2.0');
  assert.equal(res.result.scope, 'app:c_1');
  assert.ok(res.result.session_id);
  assert.ok(res.result.subscribed_at);
  // Verify session was created
  const session = b.getSession(c, 'app:c_1');
  assert.ok(session);
  assert.equal(session.sessionId, res.result.session_id);
});

test('ScopeRouter: routeEnvelope unsubscribe returns success when subscribed', async () => {
  const b = createBridge();
  const c = connId();
  // Subscribe first
  await b.routeEnvelope(validEnvelope({ method: 'subscribe', id: 's1' }), c);
  // Then unsubscribe
  const env = validEnvelope({ method: 'unsubscribe', id: 'u1', scope_session_id: null });
  const res = await b.routeEnvelope(env, c);
  assert.equal(res.result.unsubscribed, true);
  assert.equal(b.getSession(c, 'app:c_1'), null);
});

test('ScopeRouter: routeEnvelope unsubscribe returns error when not subscribed', async () => {
  const b = createBridge();
  const c = connId();
  const env = validEnvelope({ method: 'unsubscribe', id: 'u1' });
  const res = await b.routeEnvelope(env, c);
  assert.equal(res.error.code, -32001);
  assert.match(res.error.message, /Not subscribed/);
});

test('ScopeRouter: routeEnvelope dispatches to registered handler', async () => {
  const b = createBridge();
  const c = connId();
  // First subscribe so a session exists
  await b.routeEnvelope(validEnvelope({ method: 'subscribe', id: 's1', scope_session_id: 'sess-1', scope_id: 'app:c_1' }), c);
  // Then invoke an application method
  const env = validEnvelope({ method: 'chat.complete', id: 'req-2', scope_session_id: 'sess-1', scope_id: 'app:c_1' });
  const res = await b.routeEnvelope(env, c);
  assert.equal(res.result.routed, true);
  assert.equal(res.result.scope, 'app:c_1');
});

test('ScopeRouter: routeEnvelope returns no_handler when no handler registered', async () => {
  const b = createBridge();
  // Remove app handler so this scope has no handler
  b.scopeHandlers.delete('app:c_1');
  b.scopeHandlers.delete('app');
  b.scopeHandlers.delete('app:*');
  const c = connId();
  const env = validEnvelope({ scope_id: 'app:c_1', method: 'chat.complete' });
  const res = await b.routeEnvelope(env, c);
  assert.equal(res.error.code, -32005);
});

test('ScopeRouter: routeEnvelope returns unknown_session_id when scope_session_id is wrong', async () => {
  const b = createBridge();
  const c = connId();
  await b.routeEnvelope(validEnvelope({ method: 'subscribe', id: 's1', scope_session_id: 'sess-real' }), c);
  const env = validEnvelope({
    method: 'chat.complete',
    id: 'req-1',
    scope_session_id: 'sess-fake',
  });
  const res = await b.routeEnvelope(env, c);
  assert.equal(res.error.code, -32002);
});

test('ScopeRouter: routeEnvelope auto-subscribes when no session exists and no scope_session_id', async () => {
  const b = createBridge();
  const c = connId();
  // No prior subscribe, no scope_session_id — use scope 'app:c_1' explicitly
  const env = {
    jsonrpc: '2.0',
    id: 'req-auto-' + Math.random().toString(36).slice(2, 8),
    scope_id: 'app:c_1',
    instance_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    method: 'chat.complete',
    params: { messages: [{ role: 'user', content: 'hello' }] },
    scope_session_id: null,
  };
  const res = await b.routeEnvelope(env, c);
  assert.equal(res.result.routed, true);
  // Session should have been auto-created with correct scope
  const session = b.getSession(c, 'app:c_1');
  assert.ok(session);
});

test('ScopeRouter: removeConnectionSessions clears all sessions for a connection', () => {
  const b = createBridge();
  const c = connId();
  b.subscribeScope(c, 'app:c_1');
  b.subscribeScope(c, 'notebook:n_2');
  b.subscribeScope(c, 'app:c_3');
  assert.equal(b.scopeSessions.get(c).size, 3);
  assert.equal(b.connectionOwner.size, 3);
  const removed = b.removeConnectionSessions(c);
  assert.equal(removed, 3);
  assert.equal(b.scopeSessions.get(c), undefined);
  assert.equal(b.connectionOwner.size, 0);
});

test('ScopeRouter: removeConnectionSessions does not affect other connections', () => {
  const b = createBridge();
  const c1 = connId();
  const c2 = connId();
  b.subscribeScope(c1, 'app:c_1');
  b.subscribeScope(c2, 'app:c_2');
  b.removeConnectionSessions(c1);
  assert.equal(b.scopeSessions.get(c1), undefined);
  assert.ok(b.scopeSessions.get(c2));
  assert.ok(b.getSession(c2, 'app:c_2'));
});

test('ScopeRouter: removeConnectionSessions fires onUnsubscribe for each session', () => {
  const b = createBridge();
  const c = connId();
  const fired = [];
  for (const scope of ['app:c_1', 'notebook:n_2']) {
    b.subscribeScope(c, scope).onUnsubscribe = (s) => fired.push(s.scopeId);
  }
  b.removeConnectionSessions(c);
  assert.ok(fired.includes('app:c_1'));
  assert.ok(fired.includes('notebook:n_2'));
});

test('ScopeRouter: onUnsubscribe hook exception is caught and logged, not thrown', () => {
  const b = createBridge();
  const c = connId();
  const session = b.subscribeScope(c, 'app:c_1');
  session.onUnsubscribe = () => { throw new Error('boom'); };
  // Should not throw
  const removed = b.removeConnectionSessions(c);
  assert.equal(removed, 1);
});

test('ScopeRouter: _matchScopePattern rules', () => {
  const b = createBridge();
  assert.equal(b._matchScopePattern('app', 'app'), true);
  assert.equal(b._matchScopePattern('app:c_1', 'app'), true);
  assert.equal(b._matchScopePattern('app:c_1', 'app:*'), true);
  assert.equal(b._matchScopePattern('app:c_1', 'notebook:*'), false);
  assert.equal(b._matchScopePattern('notebook:n_1', 'notebook'), true);
  assert.equal(b._matchScopePattern('notebook:n_1', 'notebook:*'), true);
  assert.equal(b._matchScopePattern('notebook:n_1', '*'), true);
  assert.equal(b._matchScopePattern('bogus:1', '*'), true);
  assert.equal(b._matchScopePattern('bogus:1', 'app'), false);
});

test('ScopeRouter: _resolveHandler exact match takes priority over pattern', () => {
  const b = createBridge();
  let callCount = 0;
  b.scopeHandlers.set('app:c_1', () => { callCount++; return { result: 'exact' }; });
  b.scopeHandlers.set('app:*', () => { callCount++; return { result: 'pattern' }; });
  const resolved = b._resolveHandler('app:c_1');
  assert.ok(resolved);
  resolved.handler({});
  assert.equal(callCount, 1); // only exact match called
});

test('ScopeRouter: _resolveHandler falls back to defaultHandler', () => {
  const b = createBridge();
  b.scopeHandlers.clear();
  b.setDefaultHandler(() => ({ result: 'default' }));
  const resolved = b._resolveHandler('bogus:1');
  assert.ok(resolved);
  assert.deepStrictEqual(resolved.handler({}), { result: 'default' });
  assert.equal(resolved.scope, 'bogus:1');
});

test('ScopeRouter: _resolveHandler returns null when no handler and no default', () => {
  const b = createBridge();
  b.scopeHandlers.clear();
  b.defaultHandler = null;
  assert.equal(b._resolveHandler('bogus:1'), null);
});

test('ScopeRouter: pruneScopeActivity removes old entries', () => {
  const b = createBridge();
  const now = Date.now();
  b.scopeLastActivity.set('scope-1', now - 700000); // > 10 min ago
  b.scopeLastActivity.set('scope-2', now - 1000);    // recent
  const pruned = b.pruneScopeActivity(600000);
  assert.equal(pruned, 1);
  assert.equal(b.scopeLastActivity.has('scope-1'), false);
  assert.equal(b.scopeLastActivity.has('scope-2'), true);
});

test('_connectionId produces unique ids per call', () => {
  const b = createBridge();
  const id1 = b._connectionId('inst-1', { 1: { toString: () => 'ws' } });
  const id2 = b._connectionId('inst-1', { 1: { toString: () => 'ws' } });
  assert.equal(id1.length, 16);
  assert.equal(id2.length, 16);
  assert.notEqual(id1, id2);
});

test('_connectionId is deterministic for same inputs (same sequence number)', () => {
  const b = createBridge();
  b._connectionSeq = 5;
  const id1 = b._connectionId('inst-1', { 1: { toString: () => 'ws' } });
  // Reset to same sequence number before second call
  b._connectionSeq = 5;
  const id2 = b._connectionId('inst-1', { 1: { toString: () => 'ws' } });
  assert.equal(id1, id2);
});
