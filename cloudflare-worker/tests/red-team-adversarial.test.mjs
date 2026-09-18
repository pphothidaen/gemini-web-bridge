import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as catalog from '../src/model-catalog.js';
import * as emulator from '../src/tool-emulator.ts';

// ─── Harness Setup ───────────────────────────────────────────
const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const context = {
  ...catalog,
  ...emulator,
  DurableObject: class {},
  crypto,
  Request,
  Response,
  URL,
  TextEncoder,
  TextDecoder,
  TextEncoderStream,
  TransformStream,
  ReadableStream,
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => {}
};

const { GeminiBridgeDO } = vm.runInNewContext(
  source.replace(/import[\s\S]*?from "[^"\n]+";/g, '')
    .replaceAll('export class ', 'class ')
    .replace('export default {', 'const entry = {') +
  '\n;({GeminiBridgeDO})',
  context
);

function createTestDO(env = {}) {
  const bridge = new GeminiBridgeDO({}, {
    CLIENT_API_TOKEN: 'client-bearer-secret-2026',
    BRIDGE_AUTH_TOKEN: 'bridge-secret-token-2026',
    ...env
  });
  bridge.currentTokens = { sessionReady: true };
  bridge.replaceModelCatalog({
    protocolVersion: 2,
    models: [
      { id: 'gemini-3.8-flash', name: '3.8 Flash', thinking: false, verification: 'verified', mapping_revision: 'rev-flash' },
      { id: 'gemini-web-thinking', name: 'Extended Thinking', thinking: true, verification: 'verified', mapping_revision: 'rev-thinking' }
    ]
  });
  return bridge;
}

// ═════════════════════════════════════════════════════════════
// 🔴 RED TEAM ATTACK VECTOR 1: Token Leak & Query Extraction Probing
// ═════════════════════════════════════════════════════════════
test('RED TEAM: Attempting credential leak via URL query parameters on all routes', async () => {
  const doHub = createTestDO();

  // Attack 1.1: Attacker attempts to pass credentials in URL query parameter
  const leakedUrls = [
    'https://edge.test/v1/models?api_key=client-bearer-secret-2026',
    'https://edge.test/v1/chat/completions?token=client-bearer-secret-2026',
    'https://edge.test/mcp?bearer=client-bearer-secret-2026'
  ];

  for (const url of leakedUrls) {
    const res = await doHub.fetch(new Request(url, {
      method: url.includes('completions') ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: url.includes('completions') ? JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }) : undefined
    }));
    // Defense: Must strictly reject (401) and NEVER accept credentials in query params
    assert.equal(res.status, 401, `URL query credential leak should be rejected for: ${url}`);
  }
});

test('RED TEAM: Attempting to leak Google CSRF token SNlM0e over the bridge', async () => {
  const doHub = createTestDO();

  // Attack 1.2: Check that /health or / never leaks internal tokens or SNlM0e
  const healthRes = await doHub.fetch(new Request('https://edge.test/health'));
  const healthText = await healthRes.text();

  assert.ok(!healthText.includes('SNlM0e'), 'Response must never leak Google CSRF token');
  assert.ok(!healthText.includes('client-bearer-secret-2026'), 'Response must never leak client secret');
  assert.ok(!healthText.includes('bridge-secret-token-2026'), 'Response must never leak bridge auth secret');
});

// ═════════════════════════════════════════════════════════════
// 🔴 RED TEAM ATTACK VECTOR 2: Prototype Pollution & Injection Fuzzing
// ═════════════════════════════════════════════════════════════
test('RED TEAM: Prototype pollution payload in JSON-RPC body', async () => {
  const doHub = createTestDO();

  // Attack 2.1: Prototype pollution attack via __proto__ injection in tool arguments
  const attackBody = JSON.parse('{"jsonrpc":"2.0","id":"fuzz-1","method":"tools/call","params":{"name":"ping","arguments":{"__proto__":{"polluted":true},"constructor":{"prototype":{"admin":true}}}}}');

  const res = await doHub.fetch(new Request('https://edge.test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer client-bearer-secret-2026',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(attackBody)
  }));

  assert.equal(res.status, 200);
  // Verify pollution did not affect global or object prototype
  assert.equal({}.polluted, undefined, 'Object prototype must not be polluted');
  assert.equal({}.admin, undefined, 'Object prototype must not have admin privilege injected');
});

test('RED TEAM: Malformed & deeply nested batch attack on /mcp', async () => {
  const doHub = createTestDO();

  // Attack 2.2: Empty batch array
  const emptyBatch = await doHub.fetch(new Request('https://edge.test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer client-bearer-secret-2026',
      'Content-Type': 'application/json'
    },
    body: '[]'
  }));
  assert.equal(emptyBatch.status, 400);

  // Attack 2.3: Non-JSON raw garbage
  const rawGarbage = await doHub.fetch(new Request('https://edge.test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer client-bearer-secret-2026',
      'Content-Type': 'application/json'
    },
    body: '<<<!!!NOT_JSON???>>>'
  }));
  assert.equal(rawGarbage.status, 400);
  const garbageData = await rawGarbage.json();
  assert.equal(garbageData.error.code, -32700); // Parse error per JSON-RPC 2.0
});

// ═════════════════════════════════════════════════════════════
// 🔴 RED TEAM ATTACK VECTOR 3: Anti-Fabrication & Strict Fail-Closed
// ═════════════════════════════════════════════════════════════
test('RED TEAM: Probing for fabricated / hallucinated model execution', async () => {
  const doHub = createTestDO();
  doHub.activeSocket = { readyState: 1 };
  doHub.protocolVersion = 2;

  // Attack 3.1: Requesting a model that does not exist in the browser catalog
  const fakeModelRes = await doHub.fetch(new Request('https://edge.test/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer client-bearer-secret-2026',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-5-turbo-ultra-fake',
      messages: [{ role: 'user', content: 'hello' }]
    })
  }));

  // Defense G2.1: Must strictly reject with 404 (model_not_available), NO mock response
  assert.equal(fakeModelRes.status, 404);
  const fakeModelData = await fakeModelRes.json();
  assert.equal(fakeModelData.error.code, 'model_not_available');
});

test('RED TEAM: Extension disconnected without GCP key strictly fails with 503', async () => {
  const doHub = createTestDO();
  // Ensure extension is disconnected and no GCP key is configured
  doHub.activeSocket = null;

  const res = await doHub.fetch(new Request('https://edge.test/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer client-bearer-secret-2026',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gemini-web-thinking',
      messages: [{ role: 'user', content: 'test message' }]
    })
  }));

  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.error.code, 'extension_disconnected');
  assert.equal(data.error.type, 'service_unavailable');
});

// ═════════════════════════════════════════════════════════════
// 🔴 RED TEAM ATTACK VECTOR 4: Queue Flooding & DoS Defense
// ═════════════════════════════════════════════════════════════
test('RED TEAM: Queue saturation flood attack (max 10 waiters)', async () => {
  const doHub = createTestDO();
  doHub.activeSocket = { readyState: 1 };
  doHub.protocolVersion = 2;
  doHub.requestBusy = true;

  // Fill the queue up to 10 pending requests
  for (let i = 0; i < 10; i++) {
    doHub.pendingRequests.push({
      resolve: () => {},
      reject: () => {},
      timer: setTimeout(() => {}, 60000)
    });
  }

  // Attack 4.1: Send 11th request when queue is at capacity
  const overflowRes = await doHub.fetch(new Request('https://edge.test/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer client-bearer-secret-2026',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'overflow test' }]
    })
  }));

  // Defense G3.1: 429 Too Many Requests immediately returned
  assert.equal(overflowRes.status, 429);
  const overflowData = await overflowRes.json();
  assert.equal(overflowData.error.code, 'queue_full');

  // Clean up timers
  for (const r of doHub.pendingRequests) clearTimeout(r.timer);
});

// ═════════════════════════════════════════════════════════════
// 🔴 RED TEAM ATTACK VECTOR 5: MCP Unauthorized Tool Calling & Fuzzing
// ═════════════════════════════════════════════════════════════
test('RED TEAM: Calling dangerous or non-existent tools on MCP endpoint', async () => {
  const doHub = createTestDO();

  const dangerousTools = ['eval', 'system_exec', 'shell', '__proto__', 'constructor', 'reboot'];

  for (const tool of dangerousTools) {
    const res = await doHub.fetch(new Request('https://edge.test/mcp', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer client-bearer-secret-2026',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `fuzz-${tool}`,
        method: 'tools/call',
        params: { name: tool, arguments: {} }
      })
    }));

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.error.code, -32602, `Tool ${tool} must return -32602 Method Not Found`);
    assert.match(data.error.message, /Tool not found/);
  }
});
