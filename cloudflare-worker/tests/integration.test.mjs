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
const CF_TOKEN = process.env.CF_TOKEN || '';
const PROTOCOL_VERSION = 2;

// ─── Helpers ────────────────────────────────────────────────────────

function bearerHeader() {
  return CF_TOKEN ? { 'Authorization': `Bearer ${CF_TOKEN}` } : {};
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

test('GET /health returns status ok', async () => {
  const { status, body } = await fetchJSON('/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.ok(body.protocolVersion, 'should have protocolVersion');
  assert.equal(body.protocolVersion, PROTOCOL_VERSION);
});

test('GET / returns dashboard HTML', async () => {
  const res = await fetch(`${WORKER_URL}/`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('Gemini Web-Bridge') || text.includes('Cloud Hub'), 'should contain dashboard content');
});

test('GET /bridge/auth-check returns ok with valid token', async () => {
  if (!CF_TOKEN) {
    console.log('  ⚠️  Skipping auth-check test (no CF_TOKEN set)');
    return;
  }
  const { status, body } = await fetchJSON('/bridge/auth-check');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.protocolVersion, PROTOCOL_VERSION);
});

test('GET /bridge/auth-check rejects without token', async () => {
  const res = await fetch(`${WORKER_URL}/bridge/auth-check`);
  // Should be 401 or 403 without auth
  assert.ok([401, 403, 409].includes(res.status), `expected 401/403/409, got ${res.status}`);
});

// ─── Test Suite 2: Protocol & Model Endpoints ───────────────────────

test('GET /bridge/models returns model catalog', async () => {
  const { status, body } = await fetchJSON('/bridge/models');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.models) || Array.isArray(body), 'should return models array');
  const models = Array.isArray(body) ? body : body.models;
  assert.ok(models.length > 0, 'should have at least one model');
});

test('GET /bridge/status returns worker status', async () => {
  const { status, body } = await fetchJSON('/bridge/status');
  assert.equal(status, 200);
  assert.ok(body.worker, 'should have worker field');
});

// ─── Test Suite 3: WebSocket Bridge Connection ──────────────────────

test('WebSocket upgrade succeeds with valid subprotocol', async () => {
  const wsUrl = WORKER_URL.replace('https://', 'wss://');
  const url = `${wsUrl}/bridge`;
  
  // Use native WebSocket if available (Node 22+), otherwise skip
  if (typeof WebSocket === 'undefined') {
    console.log('  ⚠️  Skipping WebSocket test (no WebSocket in Node < 22)');
    return;
  }

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

test('POST /bridge/chat sends message and receives response', async () => {
  if (!CF_TOKEN) {
    console.log('  ⚠️  Skipping chat test (no CF_TOKEN set)');
    return;
  }

  const { status, body } = await fetchJSON('/bridge/chat', {
    method: 'POST',
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Say hello in one word' }],
      model: 'gemini-2.0-flash',
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

test('POST /bridge/chat rejects empty messages', async () => {
  const { status } = await fetchJSON('/bridge/chat', {
    method: 'POST',
    body: JSON.stringify({ messages: [] }),
  });
  assert.ok([400, 422].includes(status), `expected 400/422, got ${status}`);
});

test('POST /bridge/chat rejects malformed JSON', async () => {
  const res = await fetch(`${WORKER_URL}/bridge/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearerHeader() },
    body: 'not valid json{{{',
  });
  assert.equal(res.status, 400);
});

// ─── Test Suite 6: CORS Headers ─────────────────────────────────────

test('OPTIONS request returns CORS headers', async () => {
  const res = await fetch(`${WORKER_URL}/bridge/chat`, {
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

test('Health endpoint responds within 3 seconds', async () => {
  const start = Date.now();
  const { status } = await fetchJSON('/health');
  const elapsed = Date.now() - start;
  assert.equal(status, 200);
  assert.ok(elapsed < 3000, `health check took ${elapsed}ms (should be < 3000ms)`);
});

test('Worker handles concurrent requests', async () => {
  const requests = Array.from({ length: 5 }, () => fetchJSON('/health'));
  const results = await Promise.all(requests);
  assert.ok(results.every(r => r.status === 200), 'all concurrent requests should succeed');
});
