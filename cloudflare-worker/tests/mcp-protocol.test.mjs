import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as catalog from '../src/model-catalog.js';
import * as emulator from '../src/tool-emulator.ts';
import * as pdfLib from 'pdf-lib';
import * as promptTemplates from '../src/prompt-templates.js';
import { makeCtx } from './helpers/fake-ctx.mjs';

const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
// Never hardcode the version in assertions — read it from package.json so the
// test can never drift from the shipped value.
const WORKER_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const context = {
  ...catalog,
  ...emulator,
  ...promptTemplates,
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
  const b = new GeminiBridgeDO(makeCtx(), { CLIENT_API_KEY: 'secret-token-123', BRIDGE_AUTH_TOKEN: 'bridge-secret' });
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
  assert.equal(data.result.serverInfo.version, WORKER_VERSION);
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
  assert.match(data.result.content[0].text, new RegExp(`Pong! Cloud Hub v${WORKER_VERSION.replace(/\./g, '\\.')} is running`));
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
  // KAN-177: notebook grounding is reported, and reads "unknown" before any
  // attach has run rather than implying grounding is fine on no evidence.
  assert.equal(healthJson.notebook.target_name, 'Horo');
  assert.equal(healthJson.notebook.target_scope, HORO_DEFAULT_NOTEBOOK_SCOPE);
  assert.equal(healthJson.notebook.last_attach_status, 'unknown');
  assert.equal(healthJson.notebook.last_attach_at, null);
  assert.equal(healthJson.notebook.attach_failures, 0);
});

test('check_bridge_health: notebook status becomes "ok" only after a real attach', async () => {
  const b = createBridge();
  b.activeSocket = { readyState: 1, send: () => {} };
  b.runNotebookAttach = async () => ({ ok: true, attached: ['Horo'] });
  b.verifyNotebookGrounding = async () => ({ ok: true, verified: true, reason: '', chipCount: 1, citeMarkers: 1, sources: ['Horo'] });
  b.executeThroughExtension = async () => 'answer';

  const call = async () => {
    const r = await postMcp(b, {
      jsonrpc: '2.0', id: 90, method: 'tools/call',
      params: { name: 'horo_consult', arguments: { query: 'q' } }
    });
    return (await r.json());
  };
  const health = async () => {
    const r = await postMcp(b, {
      jsonrpc: '2.0', id: 91, method: 'tools/call',
      params: { name: 'check_bridge_health' }
    });
    return JSON.parse((await r.json()).result.content[0].text);
  };

  assert.equal((await health()).notebook.last_attach_status, 'unknown');
  await call();
  const after = (await health()).notebook;
  assert.equal(after.last_attach_status, 'ok');
  assert.ok(after.last_attach_at, 'the attach time must be recorded');
  assert.equal(after.last_attach_reason, null);
  assert.equal(after.attach_failures, 0);
});

test('check_bridge_health: a failed attach is recorded with its reason and counted', async () => {
  // The failure path returns an error to the caller, so without this record
  // the health check would keep reporting "unknown" forever and the one
  // signal that says grounding is broken would be invisible.
  const b = createBridge();
  b.activeSocket = { readyState: 1, send: () => {} };
  b.runNotebookAttach = async () => ({ ok: false, reason: 'tab_not_visible', step: 'visibility', attached: [] });

  await postMcp(b, {
    jsonrpc: '2.0', id: 92, method: 'tools/call',
    params: { name: 'horo_consult', arguments: { query: 'q' } }
  });
  const healthRes = await postMcp(b, {
    jsonrpc: '2.0', id: 93, method: 'tools/call',
    params: { name: 'check_bridge_health' }
  });
  const nb = JSON.parse((await healthRes.json()).result.content[0].text).notebook;
  assert.equal(nb.last_attach_status, 'failed');
  assert.equal(nb.last_attach_reason, 'tab_not_visible');
  assert.equal(nb.attach_failures, 1);
  assert.ok(nb.last_attach_at);

  // A second failure must accumulate, not reset.
  await postMcp(b, {
    jsonrpc: '2.0', id: 94, method: 'tools/call',
    params: { name: 'horo_consult', arguments: { query: 'q' } }
  });
  const health2 = await postMcp(b, {
    jsonrpc: '2.0', id: 95, method: 'tools/call',
    params: { name: 'check_bridge_health' }
  });
  assert.equal(JSON.parse((await health2.json()).result.content[0].text).notebook.attach_failures, 2);
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
  assert.match(callData.result.content[0].text, new RegExp(`Pong! Cloud Hub v${WORKER_VERSION.replace(/\./g, '\\.')} is running`));
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
  const scopeDesc = tool.inputSchema.properties.scope.description;
  assert.match(scopeDesc, /https:\/\/gemini\.google\.com\/app/, 'scope description must document the App default');
  assert.ok(scopeDesc.includes(HORO_DEFAULT_NOTEBOOK_SCOPE), 'scope description must document the HoroConsultant notebook default');
  // KAN-177: the notebook is attached in place, not navigated to, and the
  // description must stop promising a scope switch-and-restore.
  assert.match(scopeDesc, /bridgeScope\.attachedInPlace=true/, 'scope description must document the in-place attach');
  assert.doesNotMatch(scopeDesc, /คืนค่า scope default เดิม/, 'no scope switch happens for horo_consult, so do not promise a restore');
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

// KAN-177: horo_consult no longer navigates the tab to /notebook/<id>.
// That page is not a chat surface — submitting there re-issues the query
// into a fresh /app/<new-id> conversation, so the scope the bridge asked
// for is gone before the answer streams. The notebook is now ATTACHED to
// the conversation already open, which keeps the URL and the scope intact.
test('horo_consult: attaches the notebook in place instead of switching scope; prompt keeps persona/birth/question', async () => {
  const b = createBridge();
  b.activeSocket = { readyState: 1, send: () => {} };
  const preparedScopes = [];
  b.prepareScope = async (scope) => { preparedScopes.push(scope); return { scope }; };
  const attaches = [];
  b.runNotebookAttach = async ({ notebookName }) => { attaches.push(notebookName); return { ok: true, attached: [notebookName] }; };
  b.verifyNotebookGrounding = async () => ({ ok: true, verified: true, reason: '', chipCount: 1, citeMarkers: 1, sources: ['Horo'] });
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

  // The notebook was attached, and NO scope switch was attempted: navigating
  // to /notebook/<id> is exactly the behaviour this replaced.
  assert.deepEqual(attaches, ['Horo']);
  assert.deepEqual(preparedScopes, [], 'must not navigate the tab to a notebook scope');

  // Proof of grounding travels with the result so a caller can tell a
  // notebook-grounded answer from a general-knowledge one.
  //
  // KAN-182: `attached` and `verified` are separate claims. `attached` says
  // the UI accepted the chip; `verified` says THIS answer cites the notebook.
  // Only the second one survives a second call, because the attachment is
  // consumed per message.
  assert.equal(data.result.notebookGrounding.attached, true);
  assert.equal(data.result.notebookGrounding.verified, true);
  assert.deepEqual(data.result.notebookGrounding.attachedNames, ['Horo']);
  // The unsafe field is gone, so nothing can read "skipped the attach" as
  // "grounded" any more.
  assert.equal(data.result.notebookGrounding.alreadyAttached, undefined);

  // Prompt construction. The template is prose, not a "[Role: ...] / Birth
  // Context: ... / User Question: ..." spec sheet — see src/prompt-templates.js.
  // What still matters is that the persona directive comes first and that both
  // the birth context and the question survive into the prompt.
  assert.ok(capturedPrompt.startsWith('Act as ซินแส AI'), 'prompt must open with the BaZi persona');
  assert.ok(capturedPrompt.includes('birth_datetime: 1997-05-10T08:30:00+07:00'), 'birth context must survive');
  assert.ok(capturedPrompt.includes('day_master: Jia Wood'), 'birth context must survive');
  assert.ok(capturedPrompt.includes('ช่วยวิเคราะห์ดวงการเงิน'), 'the user question must survive');
  assert.doesNotMatch(capturedPrompt, /\[Role:/, 'no label block');
});

// A failed attach must be a loud error, never a silent ungrounded answer.
test('horo_consult: a failed notebook attach is an explicit error, not an ungrounded answer', async () => {
  const b = createBridge();
  b.activeSocket = { readyState: 1, send: () => {} };
  b.runNotebookAttach = async () => ({ ok: false, reason: 'tab_not_visible', step: 'visibility', attached: [] });
  let executed = false;
  b.executeThroughExtension = async () => { executed = true; return 'should never be reached'; };

  const res = await postMcp(b, {
    jsonrpc: '2.0', id: 64, method: 'tools/call',
    params: { name: 'horo_consult', arguments: { query: 'q' } }
  });

  const data = await res.json();
  assert.ok(data.error, 'expected a JSON-RPC error, got: ' + JSON.stringify(data));
  assert.match(data.error.message, /Could not attach the HoroConsultant notebook/);
  // The step and reason must survive, or the message is unactionable.
  assert.match(data.error.message, /tab_not_visible/);
  assert.equal(executed, false, 'must not ask Gemini without the notebook attached');
});

// KAN-182: a successful attach is NOT a successful grounding. The attachment
// is consumed per message, so a call that reuses a chip the previous message
// already spent gets a fluent answer written from general knowledge — and
// nothing in that text tells the caller. Returning it as a grounded
// horo_consult reading is the failure this test exists to prevent.
test('horo_consult: an attached but uncited answer is an error, not a grounded reading', async () => {
  const b = createBridge();
  b.activeSocket = { readyState: 1, send: () => {} };
  b.runNotebookAttach = async () => ({ ok: true, attached: ['Horo'] });
  b.verifyNotebookGrounding = async () => ({
    ok: true, verified: false, reason: 'no_citations_in_response', chipCount: 0, citeMarkers: 0, sources: []
  });
  b.executeThroughExtension = async () => 'หมี่เข้ากับการเงิน มีแนวโน้มดี…';

  const res = await postMcp(b, {
    jsonrpc: '2.0', id: 65, method: 'tools/call',
    params: { name: 'horo_consult', arguments: { query: 'q' } }
  });

  const data = await res.json();
  assert.ok(data.error, 'an ungrounded answer must not be returned as a result');
  assert.match(data.error.message, /no citations from it/);
  assert.match(data.error.message, /no_citations_in_response/, 'the reason must survive for triage');
  // The ungrounded text must not leak through the error path either.
  assert.equal(JSON.stringify(data).includes('แนวโน้มดี'), false);
});

// KAN-182: health must track grounding separately from the attach, because an
// attach can succeed while every answer that follows is ungrounded.
test('check_bridge_health: reports grounding separately from the attach', async () => {
  const b = createBridge();
  b.activeSocket = { readyState: 1, send: () => {} };
  b.runNotebookAttach = async () => ({ ok: true, attached: ['Horo'] });
  b.verifyNotebookGrounding = async () => ({
    ok: true, verified: false, reason: 'no_citations_in_response', chipCount: 0, citeMarkers: 0, sources: []
  });
  b.executeThroughExtension = async () => 'an answer with no citations';

  await postMcp(b, {
    jsonrpc: '2.0', id: 66, method: 'tools/call',
    params: { name: 'horo_consult', arguments: { query: 'q' } }
  });

  const healthRes = await postMcp(b, {
    jsonrpc: '2.0', id: 67, method: 'tools/call',
    params: { name: 'check_bridge_health' }
  });
  const nb = JSON.parse((await healthRes.json()).result.content[0].text).notebook;

  // The attach worked…
  assert.equal(nb.last_attach_status, 'ok');
  // …and the answer was still ungrounded, which the old report could not say.
  assert.equal(nb.last_grounding_status, 'ungrounded');
  assert.equal(nb.last_grounding_reason, 'no_citations_in_response');
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

// KAN-177: with no explicit scope there is no scope switch at all, so the
// pre-call scope is trivially preserved — the attach flow cannot leak it.
test('horo_consult: leaves the session scope untouched when attaching in place (no sticky scope leak)', async () => {
  const b = createBridge();
  b.activeSocket = { readyState: 1, send: () => {} };
  b.currentScope = 'app'; // session was on /app before the horo call
  const preparedScopes = [];
  b.prepareScope = async (scope) => { preparedScopes.push(scope); return { scope }; };
  b.runNotebookAttach = async () => ({ ok: true, attached: ['Horo'] });
  b.verifyNotebookGrounding = async () => ({ ok: true, verified: true, reason: '', chipCount: 1, citeMarkers: 1, sources: ['Horo'] });
  let scopeDuringExecution = null;
  b.executeThroughExtension = async () => { scopeDuringExecution = b.currentScope; return 'answer'; };

  const res = await postMcp(b, {
    jsonrpc: '2.0',
    id: 66,
    method: 'tools/call',
    params: { name: 'horo_consult', arguments: { query: 'q' } }
  });

  const data = await res.json();
  assert.ok(data.result, 'expected success, got: ' + JSON.stringify(data.error || data));

  // The answer was produced on the conversation that was already open...
  assert.equal(scopeDuringExecution, 'app');
  // ...and nothing navigated anywhere, so the next unscoped tool call cannot
  // inherit a Notebook scope that was never set.
  assert.deepEqual(preparedScopes, []);
  assert.equal(b.currentScope, 'app');

  // Callers see the notebook scope that served the answer, plus the flag
  // that says it was attached in place rather than navigated to.
  assert.equal(data.result.bridgeScope.used, HORO_DEFAULT_NOTEBOOK_SCOPE);
  assert.equal(data.result.bridgeScope.active, 'app');
  assert.equal(data.result.bridgeScope.restored, false);
  assert.equal(data.result.bridgeScope.attachedInPlace, true);
  assert.equal(data.result.notebookGrounding.attached, true);
});

test('horo_consult: explicit scope is used for the call, then the pre-call scope is restored', async () => {
  const b = createBridge();
  b.activeSocket = { readyState: 1, send: () => {} };
  b.currentScope = 'app:conv-original';
  const preparedScopes = [];
  b.prepareScope = async (scope) => { preparedScopes.push(scope); return { scope }; };
  let scopeDuringExecution = null;
  b.executeThroughExtension = async () => { scopeDuringExecution = b.currentScope; return 'answer'; };

  const res = await postMcp(b, {
    jsonrpc: '2.0',
    id: 67,
    method: 'tools/call',
    params: { name: 'horo_consult', arguments: { query: 'q', scope: 'notebook:nb-explicit' } }
  });

  const data = await res.json();
  assert.ok(data.result, 'expected success, got: ' + JSON.stringify(data.error || data));
  // The explicit scope serves this call, then the session returns to the scope
  // it was on before — tool arguments are per-call, not a session mutation.
  assert.equal(scopeDuringExecution, 'notebook:nb-explicit');
  assert.deepEqual(preparedScopes, ['notebook:nb-explicit', 'app:conv-original']);
  assert.equal(b.currentScope, 'app:conv-original');
  assert.equal(data.result.bridgeScope.used, 'notebook:nb-explicit');
  assert.equal(data.result.bridgeScope.restored, true);
  assert.equal(data.result.bridgeScope.active, 'app:conv-original');
});

test('horo_consult: no restore when the requested scope equals the current scope', async () => {
  const b = createBridge();
  b.activeSocket = { readyState: 1, send: () => {} };
  b.currentScope = 'app';
  const preparedScopes = [];
  b.prepareScope = async (scope) => { preparedScopes.push(scope); return { scope }; };
  b.executeThroughExtension = async () => 'answer';

  const res = await postMcp(b, {
    jsonrpc: '2.0',
    id: 73,
    method: 'tools/call',
    params: { name: 'horo_consult', arguments: { query: 'q', scope: 'app' } }
  });

  const data = await res.json();
  assert.ok(data.result, 'expected success, got: ' + JSON.stringify(data.error || data));
  // No switch happened, so there is nothing to undo: exactly one no-op
  // applyScope call and no extra navigation.
  assert.deepEqual(preparedScopes, []);
  assert.equal(b.currentScope, 'app');
  assert.deepEqual(data.result.bridgeScope, { used: 'app', active: 'app', restored: false });
});

test('horo_consult: does not move the session when execution fails after a successful attach', async () => {
  const b = createBridge();
  b.activeSocket = { readyState: 1, send: () => {} };
  b.currentScope = 'app';
  const preparedScopes = [];
  b.prepareScope = async (scope) => { preparedScopes.push(scope); return { scope }; };
  b.runNotebookAttach = async () => ({ ok: true, attached: ['Horo'] });
  b.verifyNotebookGrounding = async () => ({ ok: true, verified: true, reason: '', chipCount: 1, citeMarkers: 1, sources: ['Horo'] });
  b.executeThroughExtension = async () => { throw new Error('boom'); };

  const res = await postMcp(b, {
    jsonrpc: '2.0',
    id: 68,
    method: 'tools/call',
    params: { name: 'horo_consult', arguments: { query: 'q' } }
  });

  const data = await res.json();
  assert.ok(data.error, 'expected JSON-RPC error, got: ' + JSON.stringify(data));
  assert.match(data.error.message, /Tool execution failed/);
  // The failure path must not leave the session somewhere new.
  assert.deepEqual(preparedScopes, []);
  assert.equal(b.currentScope, 'app');
});

test('sdlc tools inherit the current scope and never trigger a notebook switch', async () => {
  const b = createBridge();
  b.activeSocket = { readyState: 1, send: () => {} };
  b.currentScope = 'app';
  const preparedScopes = [];
  b.prepareScope = async (scope) => { preparedScopes.push(scope); return { scope }; };
  let scopeDuringExecution = null;
  b.executeThroughExtension = async () => { scopeDuringExecution = b.currentScope; return 'answer'; };

  for (const [id, name, args] of [
    [69, 'sdlc_solution_architect', { problem_description: 'p' }],
    [70, 'orchestrate_sdlc_plan', { feature_or_goal: 'g' }],
    [71, 'code_review_and_debug', { code_snippet: 'c' }],
    [72, 'evaluate_tech_tradeoffs', { decision_context: 'd', options: 'o' }]
  ]) {
    const res = await postMcp(b, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    const data = await res.json();
    assert.ok(data.result, `${name} expected success, got: ` + JSON.stringify(data.error || data));
    assert.equal(scopeDuringExecution, 'app', `${name} must run on the current scope`);
  }

  assert.deepEqual(preparedScopes, [], 'no scope switch should be requested by unscoped SDLC tools');
  assert.equal(b.currentScope, 'app');
});

test('horo_consult: response_format=pdf stores artifact in KV with 1h TTL and returns absolute unauthenticated pdf_url', async () => {
  const b = createBridge();
  b.activeSocket = { readyState: 1, send: () => {} };
  b.prepareScope = async (scope) => ({ scope });
  // KAN-177: the default-scoped path attaches the notebook first. Without
  // this stub the real runNotebookAttach waits out its 45s timeout, which
  // turns this KV assertion into a slow, misleading failure.
  b.runNotebookAttach = async () => ({ ok: true, attached: ['Horo'] });
  b.verifyNotebookGrounding = async () => ({ ok: true, verified: true, reason: '', chipCount: 1, citeMarkers: 1, sources: ['Horo'] });
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
  // KAN-177: stub the notebook attach so this asserts PDF degradation rather
  // than the attach timeout.
  b.runNotebookAttach = async () => ({ ok: true, attached: ['Horo'] });
  b.verifyNotebookGrounding = async () => ({ ok: true, verified: true, reason: '', chipCount: 1, citeMarkers: 1, sources: ['Horo'] });
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

