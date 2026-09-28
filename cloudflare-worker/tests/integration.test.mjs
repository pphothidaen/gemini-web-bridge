/**
 * Integration Tests: Extension → Worker → Gemini Flow
 * 
 * Tests the full end-to-end pipeline:
 * 1. Worker health/auth endpoints
 * 2. WebSocket bridge connection
 * 3. Gemini RPC request encoding
 * 4. Response decoding and streaming
 * 5. Tool execution loop
 * 
 * Run with: node --test tests/integration.test.mjs
 * 
 * Requires WORKER_URL environment variable pointing to a deployed worker.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const WORKER_URL = process.env.WORKER_URL || 'https://prod.gemini-web-bridge.workers.dev';
const CLIENT_API_KEY = process.env.CLIENT_API_KEY || process.env.CF_TOKEN || '';
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || '';
const PROTOCOL_VERSION = 3;

// Every test in this file hits the LIVE worker, and all but /health and the
// unauthenticated-rejection checks need a valid token. CI does not pass
// CF_TOKEN to the test job, so these ran against production with no
// credentials and failed on 401.
//
// They previously "guarded" themselves with `if (!CF_TOKEN) return`, which is
// not a skip: a bare return makes the test pass without asserting anything,
// and node reports it as `ok` — indistinguishable from a real pass. So the
// suite was simultaneously broken (7 failures) and dishonest about it.
//
// Gate the whole file on the credential instead. `skip` on the test context
// reports as skipped with a reason, so the summary reflects what actually
// ran. Set CF_TOKEN (and WORKER_URL to point at the target) to exercise it —
// the redteam-token-test job already proves both tokens against production.
const skip = (CLIENT_API_KEY || BRIDGE_SECRET) ? false : 'No tokens set — live-server tests not exercised';

// A further, harder dependency, and the two remaining tests split apart here.
//
// `POST /v1/chat/completions` with a real message must route through a genuine
// Gemini session, so it needs a browser extension actually connected to the DO.
// With no extension the worker answers 503, and it fails intermittently whenever
// the 45s stale-connection timeout lapses between runs. That test is opt-in via
// BRIDGE_LIVE_EXTENSION=1, which must be set only when a browser is genuinely
// connected.
//
// The WebSocket test is gated on the OPPOSITE condition and cannot share that
// gate. The worker enforces a single-instance connection lease: with an
// extension attached and healthy, every new instanceId is refused with 409,
// which is correct production behaviour. Asserting a successful upgrade in that
// state would demand the worker break its own conflict detection. So this test
// needs the lease to be FREE, and skips with a truthful reason when it is not.
// (phase5-instance-id.test.mjs already models this correctly via
// detectBusyLease(); the same reasoning applies here.)
//
// It also must not request a subprotocol. The worker builds its 101 from a bare
// WebSocketPair and never echoes Sec-WebSocket-Protocol, so per RFC 6455 a
// client that offered one must fail the handshake — the previous
// `new WebSocket(url, ['gemini-bridge-v2'])` therefore could never pass, and
// failed with 1006 before a single assertion ran. phase5-instance-id.test.mjs
// documents the A/B that proves this.
const skipLive = process.env.BRIDGE_LIVE_EXTENSION === '1'
  ? false
  : 'needs a connected browser extension — set BRIDGE_LIVE_EXTENSION=1 to run';

let leaseTaken = false;
let leaseDetail = '';

/**
 * Is a *real* extension holding the connection lease right now?
 *
 * `isStale` is NOT enough to conclude the lease is free. The DO reaps a socket
 * only after 45s of silence, and the extension's MV3 service worker can be
 * quiet for that long between WebSocket frames without being gone. During that
 * window /health reports the connection as stale while the worker still holds
 * the slot, and a new instanceId that arrives then is treated as a competitor:
 * the DO evicts the real extension and the test's socket takes the lease.
 *
 * That is not hypothetical — it happened while verifying this fix against
 * production. /health showed one stale connection, the gate concluded the lease
 * was free, the upgrade succeeded, and the live extension was displaced
 * (`DISCONNECTED`, `epoch` bumped). It reconnected on its own ~30s later, so
 * nothing broke, but a test run must never be able to knock the bridge offline
 * for whoever is using it.
 *
 * So treat ANY tracked connection as a held lease, stale or not. Only a DO
 * reporting no connections at all is genuinely free.
 */
async function detectBusyLease() {
  if (process.env.BRIDGE_LIVE_EXTENSION === '1') return;
  // Reset first: this runs more than once, and a stale `true` from the
  // import-time snapshot would otherwise skip a test whose lease is now free.
  leaseTaken = false;
  leaseDetail = '';
  try {
    const res = await fetch(`${WORKER_URL}/health`);
    const body = await res.json();
    const tracked = body?.instance_tracking?.connections ?? [];
    if (tracked.length > 0) {
      leaseTaken = true;
      leaseDetail = tracked
        .map((c) => `${c.instanceId}${c.isStale ? ' (stale)' : ''}`)
        .join(',');
    }
  } catch {
    // /health unreachable — run the test and let it report its own failure.
  }
}

// Resolved once, up front, rather than from a `skip: async () => ...`.
// node:test does not await a Promise returned from the `skip` option: it
// treats the Promise itself as truthy and skips with the bare label "SKIP",
// discarding the reason. Probed on Node 26. An async skip would therefore have
// hidden exactly the explanation this gate exists to give.
await detectBusyLease();

const skipLease = leaseTaken
  ? `connection lease held by live extension (${leaseDetail}) — this test needs it free`
  : false;

// ─── Helpers ────────────────────────────────────────────────────────

function bearerHeader() {
  return CLIENT_API_KEY ? { 'Authorization': `Bearer ${CLIENT_API_KEY}` } : {};
}

async function fetchJSON(path, options = {}) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...bearerHeader() },
    ...options,
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text), headers: res.headers };
  } catch {
    return { status: res.status, body: text, headers: res.headers };
  }
}

// ─── Test Suite 1: Health & Auth Endpoints ──────────────────────────

test('GET /health returns status ok', { skip }, async () => {
  const { status, body } = await fetchJSON('/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
});

test('GET / returns dashboard HTML', { skip }, async () => {
  const { status, body } = await fetchJSON('/');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.ok(body.service === 'gemini-web-bridge-cloud-hub', 'should return service info');
});

test('GET /bridge/auth-check returns ok with valid token', { skip }, async () => {
  const res = await fetch(`${WORKER_URL}/bridge/auth-check`, {
    headers: { 'x-bridge-token': BRIDGE_SECRET }
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.protocolVersion, PROTOCOL_VERSION);
});

test('GET /bridge/auth-check rejects without token', { skip }, async () => {
  const res = await fetch(`${WORKER_URL}/bridge/auth-check`);
  // Should be 401 or 403 without auth
  assert.ok([401, 403, 409].includes(res.status), `expected 401/403/409, got ${res.status}`);
});

// ─── Test Suite 2: Protocol & Model Endpoints ───────────────────────

test('GET /v1/models returns model catalog', { skip }, async () => {
  const { status, body } = await fetchJSON('/v1/models');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.data) || Array.isArray(body), 'should return models array');
  const models = Array.isArray(body) ? body : body.data;
  // An empty catalog is a legitimate state, not a failure: the catalog is
  // populated by the connected extension reporting what the browser exposes,
  // and it is empty whenever no extension has published yet (fresh DO, or the
  // 45s stale-connection timeout lapsed). Asserting non-empty here made the
  // suite fail on infrastructure state rather than on a defect — and the
  // shape of the response is the part this file can actually vouch for.
  if (models.length === 0) {
    console.log('  ℹ️  catalog is empty (no extension has published models); shape is still valid');
  }
  for (const m of models) {
    assert.equal(typeof m.id, 'string', 'each model needs a string id');
  }
  assert.equal(typeof body.catalog_revision, 'string', 'catalog_revision should be present');
});



// ─── Test Suite 3: WebSocket Bridge Connection ──────────────────────

// `skipLease` alone is not enough: with no tokens set this test would still
// run, build a tokenless URL, and collect a legitimate 401 that has nothing to
// do with the upgrade path it is meant to verify. Gate on both, and report
// whichever is actually missing.
const skipUpgrade = skip || skipLease;

test('WebSocket upgrade succeeds with valid subprotocol', { skip: skipUpgrade }, async (t) => {
  // Re-check the lease immediately before connecting. `skipLease` is a snapshot
  // taken at import time, and the gap between then and here is enough for the
  // extension to attach: observed live as `readyState=3` in onerror, because
  // the DO had just evicted a departing instance and had not yet accepted a new
  // one. That is a transient worker state, not a defect in the upgrade path, so
  // report it as a skip with the reason rather than a false failure.
  await detectBusyLease();
  if (leaseTaken) {
    t.skip(`connection lease taken since load (${leaseDetail}) — this test needs it free`);
    return;
  }

  const wsUrl = WORKER_URL.replace('https://', 'wss://');
  // instanceId is REQUIRED. The DO rejects any /bridge upgrade without a
  // UUID instanceId with 401 "Unauthorized: Invalid instance ID" — the same
  // defect that stopped the extension's fallback path connecting at all.
  // Without it this test can never pass, for reasons unrelated to whether
  // the bridge works.
  const token = BRIDGE_SECRET ? `?token=${encodeURIComponent(BRIDGE_SECRET)}` : (CLIENT_API_KEY ? `?token=${encodeURIComponent(CLIENT_API_KEY)}` : '');
  const instanceId = crypto.randomUUID();
  const url = `${wsUrl}/bridge${token}&instanceId=${instanceId}`;

  // No subprotocol is requested, and that is load-bearing. The worker builds
  // its 101 from a bare WebSocketPair and never echoes Sec-WebSocket-Protocol.
  // Per RFC 6455 a client that offered subprotocols but receives none must fail
  // the handshake, so the previous `new WebSocket(url, ['gemini-bridge-v2'])`
  // could never pass — it died with 1006 before any assertion ran. The test name
  // is retained for continuity with the suite history; what it actually
  // verifies is the authenticated upgrade with a valid instanceId.
  const ws = new WebSocket(url);

  // Assert the UPGRADE, which is what this test is named for. The DO is silent
  // on connect: it returns a bare 101 and waits for the client to speak first,
  // answering only SESSION_READY / MODELS_DISCOVERED / PONG (index.js:1870-1884).
  // The previous version sent a lowercase {type:'ping'} and then waited for a
  // 'pong' — a message type the DO does not handle — so it always burned the
  // full 10s timeout and failed even when the upgrade had fully succeeded.
  // Confirmed against a live host with a free lease: onopen fires, then silence.
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { ws.close(); } catch { /* already closing */ }
      reject(new Error('WebSocket upgrade timed out (no 101 within 10s)'));
    }, 10000);

    ws.onopen = () => { clearTimeout(timeout); resolve(); };
    ws.onerror = () => {
      clearTimeout(timeout);
      // A refused upgrade surfaces here: 401 for a bad token or a missing or
      // malformed instanceId, 409 when another instance holds the lease.
      reject(new Error(`WebSocket upgrade failed (readyState=${ws.readyState})`));
    };
  });

  assert.equal(ws.readyState, WebSocket.OPEN, 'socket should be OPEN after a 101');

  // Close cleanly and let the DO observe it, so the lease is released promptly
  // for the next run instead of lingering until the 45s stale reaper fires.
  ws.close(1000, 'test complete');
  await new Promise((resolve) => { ws.onclose = resolve; setTimeout(resolve, 2000); });
});

// ─── Test Suite 4: Gemini RPC Flow ───────────────────────────────────

test('POST /v1/chat/completions sends message and receives response', { skip: skipLive }, async () => {
  const { status, body } = await fetchJSON('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gemini-3.8-flash-thinking',
      messages: [{ role: 'user', content: 'Say hello in one word' }],
      max_tokens: 16,
    }),
  });

  assert.equal(status, 200);
  assert.ok(body, 'should return a response');
  // Response may be streaming or direct
  if (body.content) {
    assert.ok(body.content.length > 0 || body.content.text, 'should have content');
  }
});

// ─── Test Suite 5: Error Handling ───────────────────────────────────

// No longer gated on a live extension. The worker validates request shape
// before its extension-readiness gate, so an empty `messages` array is a 400
// whether or not a browser is attached. It used to be gated because validation
// ran *after* the gate: with no extension the worker returned 503, so the 400
// this asserts was unreachable and the test could only be exercised while a
// browser happened to be connected.
test('POST /v1/chat/completions rejects empty messages', { skip }, async () => {
  const { status } = await fetchJSON('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ messages: [] }),
  });
  assert.ok([400, 401, 422].includes(status), `expected 400/401/422, got ${status}`);
});

test('POST /v1/chat/completions rejects malformed JSON', { skip }, async () => {
  const res = await fetch(`${WORKER_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearerHeader() },
    body: 'not valid json{{{',
  });
  assert.ok([400, 401].includes(res.status), `expected 400/401, got ${res.status}`);
});

// ─── Test Suite 6: CORS Headers ─────────────────────────────────────

test('OPTIONS request returns CORS headers', { skip }, async () => {
  const res = await fetch(`${WORKER_URL}/v1/chat/completions`, {
    method: 'OPTIONS',
    headers: {
      'Origin': 'chrome-extension://test',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type,Authorization',
    },
  });
  const allowOrigin = res.headers.get('access-control-allow-origin');
  assert.ok(allowOrigin, 'should have access-control-allow-origin header');
});

// ─── Test Suite 7: Performance ──────────────────────────────────────

test('Health endpoint responds within 3 seconds', { skip }, async () => {
  const start = Date.now();
  const { status } = await fetchJSON('/health');
  const elapsed = Date.now() - start;
  assert.equal(status, 200);
  assert.ok(elapsed < 3000, `health check took ${elapsed}ms (should be < 3000ms)`);
});

test('Worker handles concurrent requests', { skip }, async () => {
  const requests = Array.from({ length: 5 }, () => fetchJSON('/health'));
  const results = await Promise.all(requests);
  assert.ok(results.every(r => r.status === 200), 'all concurrent requests should succeed');
});
