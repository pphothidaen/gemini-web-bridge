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

const WORKER_URL = process.env.WORKER_URL || 'https://gemini-web-bridge.pansakorn-pho.workers.dev';
const CLIENT_API_TOKEN = process.env.CLIENT_API_TOKEN || process.env.CF_TOKEN || '';
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || '';
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
const skip = (CLIENT_API_TOKEN || BRIDGE_AUTH_TOKEN) ? false : 'No tokens set — live-server tests not exercised';

// ─── Helpers ────────────────────────────────────────────────────────

function bearerHeader() {
  return CLIENT_API_TOKEN ? { 'Authorization': `Bearer ${CLIENT_API_TOKEN}` } : {};
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
    headers: { 'x-bridge-token': BRIDGE_AUTH_TOKEN }
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
  assert.ok(models.length > 0, 'should have at least one model');
});



// ─── Test Suite 3: WebSocket Bridge Connection ──────────────────────

test('WebSocket upgrade succeeds with valid subprotocol', { skip }, async () => {
  const wsUrl = WORKER_URL.replace('https://', 'wss://');
  const token = BRIDGE_AUTH_TOKEN ? `?token=${encodeURIComponent(BRIDGE_AUTH_TOKEN)}` : (CLIENT_API_TOKEN ? `?token=${encodeURIComponent(CLIENT_API_TOKEN)}` : '');
  const url = `${wsUrl}/bridge${token}`;

  // Use native WebSocket if available (Node 22+), otherwise skip
  const ws = new WebSocket(url, ['gemini-bridge-v2']);
  
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket connection timeout'));
    }, 10000);

    ws.onopen = () => {
      // Send a ping message
      ws.send(JSON.stringify({ type: 'ping' }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'pong' || msg.type === 'connected') {
          clearTimeout(timeout);
          ws.close();
          resolve({ connected: true, response: msg });
        }
      } catch {
        // Non-JSON message, still connected
        clearTimeout(timeout);
        ws.close();
        resolve({ connected: true, raw: event.data });
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(new Error('WebSocket error'));
    };
  });

  assert.ok(result.connected, 'should establish WebSocket connection');
});

// ─── Test Suite 4: Gemini RPC Flow ───────────────────────────────────

test('POST /v1/chat/completions sends message and receives response', { skip }, async () => {
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
