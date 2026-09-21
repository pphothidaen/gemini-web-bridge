import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as catalog from '../src/model-catalog.js';
import * as emulator from '../src/tool-emulator.ts';
import * as pdfLib from 'pdf-lib';

const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const context = {
  ...catalog,
  ...emulator,
  ...pdfLib,
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

function createBridge() {
  const b = new GeminiBridgeDO({}, { CLIENT_API_TOKEN: 'secret-token-123', BRIDGE_AUTH_TOKEN: 'bridge-secret' });
  b.currentTokens = { sessionReady: true };
  b.replaceModelCatalog({
    protocolVersion: 2,
    models: [{ id: 'gemini-web-thinking', name: 'Gemini Web Thinking', thinking: true, verification: 'verified', mapping_revision: 'rev-1' }]
  });
  return b;
}

test('MCP Authentication: strictly rejects unauthorized requests on /mcp and rejects query parameter credentials', async () => {
  const b = createBridge();

  // 1. Missing auth on GET /mcp
  const getNoAuth = await b.fetch(new Request('https://test/mcp', { method: 'GET' }));
  assert.equal(getNoAuth.status, 401);
  const getNoAuthBody = await getNoAuth.json();
  assert.equal(getNoAuthBody.error.code, 'invalid_api_key');

  // 2. Invalid auth on POST /mcp
  const postBadAuth = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  }));
  assert.equal(postBadAuth.status, 401);

  // 3. Missing auth on DELETE /mcp
  const delNoAuth = await b.fetch(new Request('https://test/mcp', { method: 'DELETE' }));
  assert.equal(delNoAuth.status, 401);

  // 4. Query param ?token= is strictly rejected (no URL query credential support)
  const getQueryToken = await b.fetch(new Request('https://test/mcp?token=secret-token-123', { method: 'GET' }));
  assert.equal(getQueryToken.status, 401);

  const postQueryToken = await b.fetch(new Request('https://test/mcp?apiKey=secret-token-123', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  }));
  assert.equal(postQueryToken.status, 401);

  // 5. Valid Bearer token succeeds
  const postGoodAuth = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: { Authorization: 'Bearer secret-token-123', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  }));
  assert.equal(postGoodAuth.status, 200);
});

test('MCP CORS: returns permissive CORS with exposed Mcp-Session-Id and Mcp-Protocol-Version', async () => {
  const b = createBridge();

  const optionsRes = await b.fetch(new Request('https://test/mcp', { method: 'OPTIONS' }));
  assert.equal(optionsRes.status, 204);
  assert.equal(optionsRes.headers.get('Access-Control-Allow-Origin'), '*');
  const exposed = optionsRes.headers.get('Access-Control-Expose-Headers');
  assert.ok(exposed.includes('Mcp-Session-Id'));
  assert.ok(exposed.includes('Mcp-Protocol-Version'));
});

test('MCP SSE Transport: GET /mcp establishes text/event-stream with endpoint event without leaking tokens', async () => {
  const b = createBridge();

  const sseRes = await b.fetch(new Request('https://test/mcp', {
    method: 'GET',
    headers: {
      Authorization: 'Bearer secret-token-123',
      Accept: 'text/event-stream'
    }
  }));

  assert.equal(sseRes.status, 200);
  assert.equal(sseRes.headers.get('Content-Type'), 'text/event-stream');
  assert.equal(sseRes.headers.get('Cache-Control'), 'no-cache, no-transform');
  const sessionId = sseRes.headers.get('Mcp-Session-Id');
  assert.ok(sessionId && sessionId.startsWith('session-'));
  assert.equal(sseRes.headers.get('Mcp-Protocol-Version'), '2024-11-05');

  // Read initial event from stream
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  const { value } = await reader.read();
  const text = decoder.decode(value);

  // Strictly assert endpoint path contains sessionId and NO token or apiKey parameter
  assert.match(text, /^event: endpoint\ndata: \/mcp\?sessionId=/);
  assert.ok(text.includes(encodeURIComponent(sessionId)));
  assert.ok(!text.includes('token='));
  assert.ok(!text.includes('apiKey='));
  assert.ok(!text.includes('secret-token-123'));
});

test('MCP Protocol: initialize returns protocolVersion, serverInfo, and tools capability', async () => {
  const b = createBridge();

  const res = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret-token-123',
      'Content-Type': 'application/json',
      'Mcp-Session-Id': 'session-client-1'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-runner', version: '1.0' }
      }
    })
  }));

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Mcp-Session-Id'), 'session-client-1');
  assert.equal(res.headers.get('Mcp-Protocol-Version'), '2024-11-05');

  const data = await res.json();
  assert.equal(data.jsonrpc, '2.0');
  assert.equal(data.id, 1);
  assert.equal(data.result.protocolVersion, '2024-11-05');
  assert.equal(data.result.serverInfo.name, 'gemini-web-bridge-cloud-hub');
  assert.equal(data.result.serverInfo.version, '4.3.4');
  assert.equal(data.result.capabilities.tools.listChanged, false);
});

test('MCP Protocol: notifications return HTTP 202 with empty body per official MCP and JSON-RPC 2.0 specs', async () => {
  const b = createBridge();

  // Test various notifications (without id and explicit notification methods)
  const notificationBodies = [
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', method: 'initialized' },
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
    { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 50 } },
    { jsonrpc: '2.0', method: 'custom/notification' } // No id -> notification
  ];

  for (const body of notificationBodies) {
    const res = await b.fetch(new Request('https://test/mcp', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token-123',
        'Content-Type': 'application/json',
        'Mcp-Session-Id': 'session-notif-1'
      },
      body: JSON.stringify(body)
    }));

    assert.equal(res.status, 202, `Method ${body.method} must return HTTP 202`);
    const text = await res.text();
    assert.equal(text, '', `Accepted notification must return empty body, got: ${text}`);
  }

  // Batch of notifications also returns HTTP 202 with empty body
  const batchRes = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret-token-123',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'initialized' }
    ])
  }));
  assert.equal(batchRes.status, 202);
  assert.equal(await batchRes.text(), '');
});

test('MCP Protocol: tools/list returns all 9 actual tools with valid schemas', async () => {
  const b = createBridge();

  const res = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret-token-123',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    })
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.id, 2);
  assert.ok(Array.isArray(data.result.tools));
  assert.equal(data.result.tools.length, 9);

  const toolNames = data.result.tools.map(t => t.name);
  assert.deepEqual(toolNames.sort(), [
    'check_bridge_health',
    'code_review_and_debug',
    'evaluate_tech_tradeoffs',
    'horo_consult',
    'list_bridge_models',
    'orchestrate_sdlc_plan',
    'ping',
    'sdlc_solution_architect',
    'set_bridge_scope'
  ].sort());

  for (const t of data.result.tools) {
    assert.ok(t.description && t.description.length > 0);
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(typeof t.inputSchema.properties === 'object');
  }
});

test('MCP Protocol: tools/call executes synthetic safe ping without requiring browser/chat', async () => {
  const b = createBridge();

  const res = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret-token-123',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'ping',
        arguments: { message: 'hello test' }
      }
    })
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.id, 3);
  assert.ok(Array.isArray(data.result.content));
  assert.equal(data.result.content[0].type, 'text');
  assert.match(data.result.content[0].text, /Pong! Cloud Hub v4\.3\.\d+ is running/);
});

test('MCP Protocol: tools/call executes check_bridge_health and returns diagnostics', async () => {
  const b = createBridge();

  const res = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret-token-123',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'check_bridge_health' }
    })
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.id, 4);
  assert.ok(Array.isArray(data.result.content));
  const healthJson = JSON.parse(data.result.content[0].text);
  assert.ok(['healthy', 'degraded', 'critical'].includes(healthJson.status));
  assert.ok(healthJson.catalog);
  assert.ok(healthJson.queue);
  assert.ok(healthJson.metrics);
  assert.equal(healthJson.hybrid_fallback.has_gcp_fallback, false);
});

test('MCP Protocol: tools/call executes list_bridge_models and returns dynamic models', async () => {
  const b = createBridge();
  // Simulate active socket so isExtensionReady is true
  b.activeSocket = { readyState: 1 };

  const res = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret-token-123',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'list_bridge_models' }
    })
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.id, 5);
  const modelData = JSON.parse(data.result.content[0].text);
  assert.ok(Array.isArray(modelData.models));
  assert.equal(modelData.models.length, 1);
  assert.equal(modelData.models[0].id, 'gemini-web-thinking');
});

test('MCP Protocol: ping method returns empty result object per MCP spec', async () => {
  const b = createBridge();

  const res = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret-token-123',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'ping',
      params: {}
    })
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.id, 99);
  assert.deepEqual(data.result, {});
});

test('MCP Protocol: unknown methods return Method Not Found (-32601) and unknown tools return (-32602)', async () => {
  const b = createBridge();

  // 1. Unknown method with id returns JSON-RPC -32601
  const methodNotFoundRes = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret-token-123',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 101,
      method: 'nonexistent/operation',
      params: {}
    })
  }));

  assert.equal(methodNotFoundRes.status, 200);
  const methodData = await methodNotFoundRes.json();
  assert.equal(methodData.id, 101);
  assert.ok(methodData.error, 'Should have error object');
  assert.equal(methodData.error.code, -32601);
  assert.match(methodData.error.message, /Method not found: nonexistent\/operation/);

  // 2. Unknown tool name returns -32602
  const toolNotFoundRes = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret-token-123',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 102,
      method: 'tools/call',
      params: { name: 'unknown_tool_xyz', arguments: {} }
    })
  }));

  assert.equal(toolNotFoundRes.status, 200);
  const toolData = await toolNotFoundRes.json();
  assert.equal(toolData.id, 102);
  assert.ok(toolData.error, 'Should have error object');
  assert.equal(toolData.error.code, -32602);
  assert.match(toolData.error.message, /Tool not found: unknown_tool_xyz/);
});

test('MCP Malformed JSON & Bad Requests: returns parse error (-32700) and invalid request (-32600)', async () => {
  const b = createBridge();

  // 1. Malformed JSON syntax
  const parseErrorRes = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret-token-123',
      'Content-Type': 'application/json'
    },
    body: '{"jsonrpc": "2.0", unclosed string'
  }));

  assert.equal(parseErrorRes.status, 400);
  const parseErrData = await parseErrorRes.json();
  assert.equal(parseErrData.error.code, -32700);
  assert.match(parseErrData.error.message, /Parse error/);

  // 2. Non-object JSON body
  const nonObjectRes = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret-token-123',
      'Content-Type': 'application/json'
    },
    body: '12345'
  }));

  assert.equal(nonObjectRes.status, 400);
  const nonObjectData = await nonObjectRes.json();
  assert.equal(nonObjectData.error.code, -32600);

  // 3. Empty batch array []
  const emptyBatchRes = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret-token-123',
      'Content-Type': 'application/json'
    },
    body: '[]'
  }));

  assert.equal(emptyBatchRes.status, 400);
  const emptyBatchData = await emptyBatchRes.json();
  assert.equal(emptyBatchData.error.code, -32600);
});

test('MCP Transport Separation: legacy SSE query session delivers via SSE with 202 empty POST response, modern POST delivers in HTTP body without duplication', async () => {
  const b = createBridge();

  // ── Part 1: Legacy SSE query session ──
  // 1. Establish SSE stream
  const sseRes = await b.fetch(new Request('https://test/mcp', {
    method: 'GET',
    headers: {
      Authorization: 'Bearer secret-token-123',
      'Mcp-Session-Id': 'session-legacy-sse'
    }
  }));
  assert.equal(sseRes.status, 200);
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();

  // Read initial endpoint event
  const initChunk = await reader.read();
  assert.match(decoder.decode(initChunk.value), /event: endpoint/);

  // 2. Post request to legacy SSE endpoint with query parameter ?sessionId=session-legacy-sse
  const legacyPostRes = await b.fetch(new Request('https://test/mcp?sessionId=session-legacy-sse', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret-token-123',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 201, method: 'tools/list', params: {} })
  }));

  // Legacy SSE POST response MUST be 202 Accepted with EMPTY BODY (no duplicated JSON-RPC response)
  assert.equal(legacyPostRes.status, 202);
  const legacyPostBody = await legacyPostRes.text();
  assert.equal(legacyPostBody, '', 'Legacy SSE POST body must be empty to avoid duplicating response');

  // The actual JSON-RPC response is delivered over the SSE stream
  const sseMessageChunk = await reader.read();
  const sseText = decoder.decode(sseMessageChunk.value);
  assert.match(sseText, /^event: message\ndata: /);
  assert.ok(sseText.includes('"id":201'));
  assert.ok(sseText.includes('sdlc_solution_architect'));

  // 3. Post to legacy SSE endpoint with invalid/unknown sessionId returns 404
  const unknownSsePost = await b.fetch(new Request('https://test/mcp?sessionId=nonexistent-session', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret-token-123',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 202, method: 'tools/list', params: {} })
  }));
  assert.equal(unknownSsePost.status, 404);

  // ── Part 2: Modern POST response behavior (Streamable HTTP) ──
  // POST directly to /mcp without ?sessionId= query param returns response directly in POST body (HTTP 200)
  const modernPostRes = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret-token-123',
      'Content-Type': 'application/json',
      'Mcp-Session-Id': 'session-modern-post'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 203, method: 'tools/list', params: {} })
  }));

  assert.equal(modernPostRes.status, 200);
  const modernData = await modernPostRes.json();
  assert.equal(modernData.id, 203);
  assert.ok(Array.isArray(modernData.result.tools));
  assert.equal(modernData.result.tools.length, 9);
});

test('MCP Protocol: prompts/list and resources/list return empty arrays cleanly', async () => {
  const b = createBridge();

  const promptRes = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: { Authorization: 'Bearer secret-token-123', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'prompts/list', params: {} })
  }));
  assert.deepEqual((await promptRes.json()).result, { prompts: [] });

  const resourceRes = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: { Authorization: 'Bearer secret-token-123', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'resources/list', params: {} })
  }));
  assert.deepEqual((await resourceRes.json()).result, { resources: [] });
});

test('MCP Protocol: DELETE /mcp terminates session and cleans up resources', async () => {
  const b = createBridge();

  // Establish SSE stream
  await b.fetch(new Request('https://test/mcp', {
    method: 'GET',
    headers: { Authorization: 'Bearer secret-token-123', 'Mcp-Session-Id': 'session-del-1' }
  }));
  assert.ok(b.mcpSessions.has('session-del-1'));

  // Delete session
  const delRes = await b.fetch(new Request('https://test/mcp', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer secret-token-123', 'Mcp-Session-Id': 'session-del-1' }
  }));
  assert.equal(delRes.status, 200);
  assert.equal((await delRes.json()).ok, true);
  assert.ok(!b.mcpSessions.has('session-del-1'));
});

test('MCP Full Client Handshake: simulates complete client lifecycle', async () => {
  const b = createBridge();
  const sessionId = 'session-full-handshake';

  // Step 1: Client sends initialize request
  const initRes = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret-token-123',
      'Content-Type': 'application/json',
      'Mcp-Session-Id': sessionId
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'antigravity-client', version: '2.0' }
      }
    })
  }));
  assert.equal(initRes.status, 200);
  const initData = await initRes.json();
  assert.equal(initData.id, 1);
  assert.equal(initData.result.serverInfo.name, 'gemini-web-bridge-cloud-hub');
  assert.ok(initData.result.capabilities.tools);

  // Step 2: Client sends initialized notification (MUST be 202 empty body)
  const notifRes = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret-token-123',
      'Content-Type': 'application/json',
      'Mcp-Session-Id': sessionId
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    })
  }));
  assert.equal(notifRes.status, 202);
  assert.equal(await notifRes.text(), '');

  // Step 3: Client sends ping request
  const pingRes = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret-token-123',
      'Content-Type': 'application/json',
      'Mcp-Session-Id': sessionId
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })
  }));
  assert.equal(pingRes.status, 200);
  const pingData = await pingRes.json();
  assert.equal(pingData.id, 2);
  assert.deepEqual(pingData.result, {});

  // Step 4: Client lists tools
  const toolsRes = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret-token-123',
      'Content-Type': 'application/json',
      'Mcp-Session-Id': sessionId
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
  }));
  assert.equal(toolsRes.status, 200);
  const toolsData = await toolsRes.json();
  assert.equal(toolsData.id, 3);
  assert.equal(toolsData.result.tools.length, 9);

  // Step 5: Client calls ping tool
  const callRes = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret-token-123',
      'Content-Type': 'application/json',
      'Mcp-Session-Id': sessionId
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'ping', arguments: {} }
    })
  }));
  assert.equal(callRes.status, 200);
  const callData = await callRes.json();
  assert.equal(callData.id, 4);
  assert.match(callData.result.content[0].text, /Pong! Cloud Hub v4\.3\.\d+ is running/);
});

test('MCP Routing: /health and / continue returning Status Dashboard while unknown returns 404', async () => {
  const b = createBridge();

  const healthRes = await b.fetch(new Request('https://test/health'));
  assert.equal(healthRes.status, 200);
  const healthData = await healthRes.json();
  assert.equal(healthData.service, 'gemini-web-bridge-cloud-hub');

  const rootRes = await b.fetch(new Request('https://test/'));
  assert.equal(rootRes.status, 200);

  const unknownRes = await b.fetch(new Request('https://test/unknown-endpoint', {
    headers: { Authorization: 'Bearer secret-token-123' }
  }));
  assert.equal(unknownRes.status, 404);
});

test('MCP Health Metrics & GCP Fallback: verifies status dashboard health_metrics and fallback routing', async () => {
  const b = createBridge();

  // 1. Health metrics in dashboard
  const healthRes = await b.fetch(new Request('https://test/health'));
  const healthData = await healthRes.json();
  assert.ok(healthData.health_metrics);
  assert.equal(healthData.health_metrics.consecutive_errors, 0);
  assert.equal(healthData.health_metrics.gcp_fallback_configured, false);

  // 2. Extension disconnected without GCP key strictly fails closed with -32000
  const noGcpRes = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: { Authorization: 'Bearer secret-token-123', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 50,
      method: 'tools/call',
      params: { name: 'sdlc_solution_architect', arguments: { problem_description: 'test' } }
    })
  }));
  const noGcpData = await noGcpRes.json();
  assert.equal(noGcpData.error.code, -32000);
  assert.match(noGcpData.error.message, /Chrome Extension is not connected/);

  // 3. Extension disconnected WITH GCP key routes to GCP fallback
  b.env.GEMINI_API_KEY = 'mock-gcp-key';
  b.callGcpGemini = async (messages) => {
    return 'GCP Architect Output';
  };

  const gcpRes = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: { Authorization: 'Bearer secret-token-123', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 51,
      method: 'tools/call',
      params: { name: 'sdlc_solution_architect', arguments: { problem_description: 'test' } }
    })
  }));
  const gcpData = await gcpRes.json();
  assert.equal(gcpData.id, 51);
  assert.ok(gcpData.result.content[0].text.includes('[Provider: GCP Gemini Fallback]'));
  assert.ok(gcpData.result.content[0].text.includes('GCP Architect Output'));
});

// ═════════════════════════════════════════════════════════════
// horo_consult MCP tool (BaZi consultation + PDF temp-link artifacts)
// ═════════════════════════════════════════════════════════════

const HORO_DEFAULT_NOTEBOOK_SCOPE = 'notebook:b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0';

function postMcp(b, body) {
  return b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: { Authorization: 'Bearer secret-token-123', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }));
}

function mockArtifactKv() {
  const store = new Map();
  return {
    store,
    put: async (key, value, opts) => { store.set(key, { value, opts }); },
    get: async (key) => (store.has(key) ? store.get(key).value : null)
  };
}

test('horo_consult: listed in tools/list with BaZi schema (query required, response_format enum, birth_context)', async () => {
  const b = createBridge();

  const res = await postMcp(b, { jsonrpc: '2.0', id: 60, method: 'tools/list', params: {} });
  assert.equal(res.status, 200);
  const data = await res.json();
  const tool = data.result.tools.find(t => t.name === 'horo_consult');
  assert.ok(tool, 'horo_consult must be listed in tools/list');
  assert.ok(tool.description.includes('BaZi'));

  assert.deepEqual(tool.inputSchema.required, ['query']);
  assert.equal(tool.inputSchema.properties.query.type, 'string');
  assert.equal(tool.inputSchema.properties.birth_context.type, 'object');
  const bcProps = tool.inputSchema.properties.birth_context.properties;
  for (const p of ['birth_datetime', 'longitude', 'utc_offset_hours', 'day_master', 'five_elements', 'favorable_elements']) {
    assert.ok(bcProps[p], `birth_context.${p} must be declared`);
  }
  assert.deepEqual(tool.inputSchema.properties.response_format.enum, ['text', 'pdf']);
  assert.equal(tool.inputSchema.properties.response_format.default, 'text');
  assert.equal(tool.inputSchema.properties.scope.type, 'string');
});

test('horo_consult: fails fast with standard extension-disconnected error when no extension is connected', async () => {
  const b = createBridge();
  b.waitForExtension = async () => false; // skip reconnect grace in test

  const res = await postMcp(b, {
    jsonrpc: '2.0',
    id: 61,
    method: 'tools/call',
    params: { name: 'horo_consult', arguments: { query: 'ดวงชะตาปีนี้เป็นอย่างไร' } }
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.error, 'expected JSON-RPC error, got: ' + JSON.stringify(data));
  assert.equal(data.error.code, -32000);
  assert.match(data.error.message, /Chrome Extension is not connected/);
});

test('horo_consult: default notebook scope applied when args.scope omitted, prompt carries Role/Birth Context/User Question', async () => {
  const b = createBridge();
  b.activeSocket = { readyState: 1, send: () => {} };
  const preparedScopes = [];
  b.prepareScope = async (scope) => { preparedScopes.push(scope); return { scope }; };
  let capturedPrompt = null;
  b.executeThroughExtension = async (messages) => { capturedPrompt = messages[0].content; return 'คำตอบทดสอบจาก Notebook'; };

  const res = await postMcp(b, {
    jsonrpc: '2.0',
    id: 62,
    method: 'tools/call',
    params: {
      name: 'horo_consult',
      arguments: {
        query: 'ช่วยวิเคราะห์ดวงการเงิน',
        birth_context: { birth_datetime: '1997-05-10T08:30:00+07:00', longitude: 100.5018, utc_offset_hours: 7, day_master: 'Jia Wood' }
      }
    }
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.id, 62);
  // Frozen contract: content[0] is the full answer text, no structuredContent in text mode
  assert.deepEqual(data.result.content, [{ type: 'text', text: 'คำตอบทดสอบจาก Notebook' }]);
  assert.equal(data.result.structuredContent, undefined);

  // Default scope: notebook:id was prepared
  assert.deepEqual(preparedScopes, [HORO_DEFAULT_NOTEBOOK_SCOPE]);

  // Prompt construction
  assert.ok(capturedPrompt.startsWith('[Role: ซินแส AI'), 'prompt must start with the BaZi role directive');
  assert.ok(capturedPrompt.includes('Birth Context: {"birth_datetime":"1997-05-10T08:30:00+07:00","longitude":100.5018,"utc_offset_hours":7,"day_master":"Jia Wood"}'));
  assert.ok(capturedPrompt.includes('User Question: ช่วยวิเคราะห์ดวงการเงิน'));
});

test('horo_consult: explicit args.scope overrides the default notebook scope', async () => {
  const b = createBridge();
  b.activeSocket = { readyState: 1, send: () => {} };
  const preparedScopes = [];
  b.prepareScope = async (scope) => { preparedScopes.push(scope); return { scope }; };
  b.executeThroughExtension = async () => 'answer';

  const res = await postMcp(b, {
    jsonrpc: '2.0',
    id: 63,
    method: 'tools/call',
    params: { name: 'horo_consult', arguments: { query: 'q', scope: 'app' } }
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.result, 'expected success, got: ' + JSON.stringify(data.error || data));
  assert.deepEqual(preparedScopes, ['app']);
});

test('horo_consult: response_format=pdf stores artifact in KV with 1h TTL and returns absolute unauthenticated pdf_url', async () => {
  const b = createBridge();
  b.activeSocket = { readyState: 1, send: () => {} };
  b.prepareScope = async (scope) => ({ scope });
  b.executeThroughExtension = async () => 'Horo Consultation Report\n\n- Section 1: ดวงชะตา (sanitized in PDF)';
  const kv = mockArtifactKv();
  b.env.ARTIFACT_KV = kv;

  const callRes = await postMcp(b, {
    jsonrpc: '2.0',
    id: 64,
    method: 'tools/call',
    params: { name: 'horo_consult', arguments: { query: 'สรุปดวงชะตา', response_format: 'pdf' } }
  });

  assert.equal(callRes.status, 200);
  const callData = await callRes.json();
  assert.ok(callData.result, 'expected success, got: ' + JSON.stringify(callData.error || callData));

  // Frozen contract: content[0] still carries the full answer text
  assert.equal(callData.result.content[0].type, 'text');
  assert.ok(callData.result.content[0].text.includes('Horo Consultation Report'));

  // structuredContent.pdf_url is an absolute URL pointing at the public route
  const pdfUrl = callData.result.structuredContent?.pdf_url;
  assert.ok(pdfUrl, 'structuredContent.pdf_url must be present in pdf mode');
  assert.match(pdfUrl, /^https:\/\/test\/artifacts\/[a-f0-9]{32}$/);

  // Artifact was stored under artifacts/<key> with expirationTtl 3600
  const keys = [...kv.store.keys()];
  assert.equal(keys.length, 1);
  assert.equal(keys[0], `artifacts/${pdfUrl.split('/').pop()}`);
  assert.equal(kv.store.get(keys[0]).opts.expirationTtl, 3600);

  // Download WITHOUT Bearer token: unguessable key IS the credential
  const dlRes = await b.fetch(new Request(pdfUrl, { method: 'GET' }));
  assert.equal(dlRes.status, 200);
  assert.equal(dlRes.headers.get('Content-Type'), 'application/pdf');
  assert.match(dlRes.headers.get('Content-Disposition'), /^attachment;/);
  const bytes = new Uint8Array(await dlRes.arrayBuffer());
  assert.ok(bytes.length > 500, 'PDF body must be non-trivial');
  assert.deepEqual([...bytes.slice(0, 4)], [0x25, 0x50, 0x44, 0x46], 'must start with %PDF magic bytes');
});

test('horo_consult: PDF generation failure degrades gracefully to text without crashing the call', async () => {
  const b = createBridge();
  b.activeSocket = { readyState: 1, send: () => {} };
  b.prepareScope = async (scope) => ({ scope });
  b.executeThroughExtension = async () => 'answer text';
  b.env.ARTIFACT_KV = { put: async () => { throw new Error('kv down'); }, get: async () => null };

  const res = await postMcp(b, {
    jsonrpc: '2.0',
    id: 65,
    method: 'tools/call',
    params: { name: 'horo_consult', arguments: { query: 'q', response_format: 'pdf' } }
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.result, 'must not fail the whole call');
  assert.ok(data.result.content[0].text.includes('answer text'));
  assert.ok(data.result.content[0].text.includes('[PDF artifact generation failed: kv down]'));
  assert.equal(data.result.structuredContent, undefined);
});

test('Artifacts route: GET /artifacts/{key} is public (no Bearer required), 404 JSON for unknown/expired keys, auth still enforced elsewhere', async () => {
  const b = createBridge();

  // 1. Unknown key -> 404 with artifact_not_found_or_expired, no auth header
  const unknownRes = await b.fetch(new Request(`https://test/artifacts/${'a'.repeat(32)}`, { method: 'GET' }));
  assert.equal(unknownRes.status, 404);
  const unknownData = await unknownRes.json();
  assert.equal(unknownData.error, 'artifact_not_found_or_expired');

  // 2. Malformed key (not 32-hex) -> same 404 contract
  const malformedRes = await b.fetch(new Request('https://test/artifacts/short-key', { method: 'GET' }));
  assert.equal(malformedRes.status, 404);
  assert.equal((await malformedRes.json()).error, 'artifact_not_found_or_expired');

  // 3. Stored key served without auth (unguessable key IS the credential)
  const kv = mockArtifactKv();
  const pdfLibMod = await import('pdf-lib');
  const doc = await pdfLibMod.PDFDocument.create();
  const bytes = await doc.save();
  await kv.put(`artifacts/${'b'.repeat(32)}`, bytes, { expirationTtl: 3600 });
  b.env.ARTIFACT_KV = kv;
  const okRes = await b.fetch(new Request(`https://test/artifacts/${'b'.repeat(32)}`, { method: 'GET' }));
  assert.equal(okRes.status, 200);
  assert.equal(okRes.headers.get('Content-Type'), 'application/pdf');

  // 4. Auth is still required on other endpoints (red-team regression guard)
  const noAuthMcp = await b.fetch(new Request('https://test/mcp', { method: 'POST', body: '{}' }));
  assert.equal(noAuthMcp.status, 401);
  const noAuthChat = await b.fetch(new Request('https://test/v1/chat/completions', { method: 'POST', body: '{}' }));
  assert.equal(noAuthChat.status, 401);
});

