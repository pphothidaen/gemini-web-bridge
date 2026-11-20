// ============================================================
// Tests for Extension Gemini Native Message Handler & Integration (KAN-352 / KAN-355)
//
// Verifies:
// 1. handleGeminiNativeRequest forwards native format directly to de.aipass.net
// 2. grounding_metadata preserved intact (no OpenAI translation)
// 3. API version pinning (X-API-Version: v1beta)
// 4. G1 zero-token-leak guardrails (no credentials or SNlM0e leaked)
// 5. BridgeSocketManager handles GEMINI_NATIVE_REQUEST and emits GEMINI_NATIVE_RESPONSE
// 6. Protocol message types and builders in protocol-messages.js
// 7. End-to-end integration between Worker DO and Extension handlers
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleGeminiNativeRequest,
  DEFAULT_AIPASS_GEMINI_ENDPOINT,
  AIPASS_API_COMPAT_VERSION,
  DEFAULT_AIPASS_TOKEN,
  BridgeSocketManager
} from '../../dist/extension/background.js';
import {
  MessageTypes,
  buildGeminiNativeRequestMessage,
  buildGeminiNativeResponseMessage,
  getProtocolInfo
} from '../../dist/extension/protocol-messages.js';
import { createMockWorker, connectFakeExtension } from './helpers/mock-worker.mjs';

const authHeaders = (worker) => ({
  Authorization: `Bearer ${worker.CLIENT_API_KEY}`,
  'Content-Type': 'application/json',
});

// ─── 1. Core handleGeminiNativeRequest Unit Tests ───

test('handleGeminiNativeRequest forwards native payload to DEFAULT_AIPASS_GEMINI_ENDPOINT without translation', async () => {
  let capturedUrl = '';
  let capturedOptions = {};

  const fakeFetch = async (url, opts) => {
    capturedUrl = url;
    capturedOptions = opts;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{
          content: { role: 'model', parts: [{ text: 'Native Gemini response' }] },
          finishReason: 'STOP',
          groundingMetadata: {
            webSearchQueries: ['AI news 2026'],
            searchEntryPoint: { renderedContent: '<search>' }
          }
        }]
      })
    };
  };

  const payload = {
    contents: [{ role: 'user', parts: [{ text: 'Latest tech news' }] }],
    tools: [{ google_search: {} }]
  };

  const res = await handleGeminiNativeRequest(payload, { fetchFn: fakeFetch });

  assert.equal(capturedUrl, DEFAULT_AIPASS_GEMINI_ENDPOINT);
  assert.equal(capturedOptions.method, 'POST');
  assert.equal(capturedOptions.headers['Content-Type'], 'application/json');
  assert.equal(capturedOptions.headers['X-API-Version'], AIPASS_API_COMPAT_VERSION);
  
  const sentBody = JSON.parse(capturedOptions.body);
  assert.deepEqual(sentBody.contents, payload.contents);
  assert.deepEqual(sentBody.tools, payload.tools);
  // Must preserve groundingMetadata intact
  assert.ok(res.candidates[0].groundingMetadata);
  assert.deepEqual(res.candidates[0].groundingMetadata.webSearchQueries, ['AI news 2026']);
});

test('handleGeminiNativeRequest preserves snake_case grounding_metadata intact', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{
        content: { role: 'model', parts: [{ text: 'Grounded content' }] },
        finishReason: 'STOP'
      }],
      grounding_metadata: {
        search_grounding: true,
        web_search_queries: ['quantum computing facts']
      }
    })
  });

  const payload = { contents: [{ role: 'user', parts: [{ text: 'Quantum facts' }] }] };
  const res = await handleGeminiNativeRequest(payload, { fetchFn: fakeFetch });

  assert.ok(res.grounding_metadata);
  assert.equal(res.grounding_metadata.search_grounding, true);
  assert.deepEqual(res.grounding_metadata.web_search_queries, ['quantum computing facts']);
});

test('handleGeminiNativeRequest allows custom endpoint and token overrides', async () => {
  let capturedUrl = '';
  let capturedHeaders = {};

  const fakeFetch = async (url, opts) => {
    capturedUrl = url;
    capturedHeaders = opts.headers;
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true })
    };
  };

  const customEndpoint = 'https://custom-gateway.local/api/gemini';
  const customToken = 'custom-auth-token-12345';

  await handleGeminiNativeRequest(
    { contents: [{ role: 'user', parts: [{ text: 'test' }] }] },
    { endpoint: customEndpoint, token: customToken, fetchFn: fakeFetch }
  );

  assert.equal(capturedUrl, customEndpoint);
  assert.equal(capturedHeaders['Authorization'], `Bearer ${customToken}`);
});

test('G1 Guardrail: handleGeminiNativeRequest NEVER sends Authorization header when token is placeholder', async () => {
  let capturedHeaders = {};

  const fakeFetch = async (url, opts) => {
    capturedHeaders = opts.headers;
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: 'ok' })
    };
  };

  await handleGeminiNativeRequest(
    { contents: [{ role: 'user', parts: [{ text: 'test' }] }] },
    { token: DEFAULT_AIPASS_TOKEN, fetchFn: fakeFetch }
  );

  assert.equal(capturedHeaders['Authorization'], undefined);
});

test('G1 Guardrail: handleGeminiNativeRequest strips envelope metadata and internal keys', async () => {
  let capturedBody = {};

  const fakeFetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: 'ok' })
    };
  };

  const wrappedPayload = {
    type: 'GEMINI_NATIVE_REQUEST',
    requestId: 'req_internal_123',
    endpoint: 'https://de.aipass.net/api/gemini/chat',
    token: 'my-token',
    scope: 'app:secret',
    timestamp: 1234567890,
    contents: [{ role: 'user', parts: [{ text: 'safe content' }] }],
    model: 'gemini-3.5-flash-lite'
  };

  await handleGeminiNativeRequest(wrappedPayload, { fetchFn: fakeFetch });

  assert.equal(capturedBody.type, undefined);
  assert.equal(capturedBody.requestId, undefined);
  assert.equal(capturedBody.token, undefined);
  assert.equal(capturedBody.scope, undefined);
  assert.equal(capturedBody.timestamp, undefined);
  assert.equal(capturedBody.model, 'gemini-3.5-flash-lite');
  assert.deepEqual(capturedBody.contents, [{ role: 'user', parts: [{ text: 'safe content' }] }]);
});

test('handleGeminiNativeRequest handles HTTP 401 unauthorized with proper code', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: async () => JSON.stringify({ error: { message: 'Invalid AIPass token' } })
  });

  await assert.rejects(
    async () => {
      await handleGeminiNativeRequest({ contents: [{ parts: [{ text: 'hi' }] }] }, { fetchFn: fakeFetch });
    },
    (err) => {
      assert.equal(err.status, 401);
      assert.equal(err.code, 'unauthorized');
      assert.ok(err.message.includes('Invalid AIPass token'));
      return true;
    }
  );
});

test('handleGeminiNativeRequest handles HTTP 429 quota exhausted with proper code', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
    text: async () => JSON.stringify({ error: { message: 'Quota exceeded for AIPass pool' } })
  });

  await assert.rejects(
    async () => {
      await handleGeminiNativeRequest({ contents: [{ parts: [{ text: 'hi' }] }] }, { fetchFn: fakeFetch });
    },
    (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.code, 'quota_exhausted');
      assert.ok(err.message.includes('Quota exceeded'));
      return true;
    }
  );
});

test('handleGeminiNativeRequest rejects empty or null payload', async () => {
  await assert.rejects(
    async () => {
      await handleGeminiNativeRequest(null);
    },
    /Invalid payload/
  );
});

// ─── 2. BridgeSocketManager GEMINI_NATIVE_REQUEST Handling ───

test('BridgeSocketManager handles GEMINI_NATIVE_REQUEST and sends GEMINI_NATIVE_RESPONSE', async () => {
  const sentMessages = [];
  const fakeSocket = {
    readyState: 1,
    send: (raw) => { sentMessages.push(JSON.parse(raw)); }
  };

  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{
        content: { role: 'model', parts: [{ text: 'Generated via BridgeSocket' }] },
        finishReason: 'STOP',
        groundingMetadata: { searchQueries: ['test query'] }
      }]
    })
  });

  const manager = new BridgeSocketManager({ fetchFn: fakeFetch });
  manager.socket = fakeSocket;
  manager._state = 'CONNECTED';

  const nativeMsg = {
    type: 'GEMINI_NATIVE_REQUEST',
    requestId: 'req_socket_native_001',
    payload: {
      contents: [{ role: 'user', parts: [{ text: 'What is 2+2?' }] }]
    }
  };

  await manager.handleGeminiNativeRequest(nativeMsg);

  assert.equal(sentMessages.length, 1);
  const resp = sentMessages[0];
  assert.equal(resp.type, MessageTypes.GEMINI_NATIVE_RESPONSE);
  assert.equal(resp.requestId, 'req_socket_native_001');
  assert.equal(resp.success, true);
  assert.ok(resp.data);
  assert.ok(resp.grounding_metadata);
  assert.deepEqual(resp.grounding_metadata.searchQueries, ['test query']);
});

test('BridgeSocketManager emits STREAM_ERROR on native execution failure', async () => {
  const sentMessages = [];
  const fakeSocket = {
    readyState: 1,
    send: (raw) => { sentMessages.push(JSON.parse(raw)); }
  };

  const fakeFetch = async () => ({
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
    text: async () => JSON.stringify({ error: { message: 'Upstream cluster error' } })
  });

  const manager = new BridgeSocketManager({ fetchFn: fakeFetch });
  manager.socket = fakeSocket;
  manager._state = 'CONNECTED';

  const nativeMsg = {
    type: 'GEMINI_NATIVE_REQUEST',
    requestId: 'req_socket_err_002',
    payload: { contents: [{ role: 'user', parts: [{ text: 'test' }] }] }
  };

  await manager.handleGeminiNativeRequest(nativeMsg);

  assert.equal(sentMessages.length, 1);
  const resp = sentMessages[0];
  assert.equal(resp.type, 'STREAM_ERROR');
  assert.equal(resp.requestId, 'req_socket_err_002');
  assert.equal(resp.code, 'native_api_error');
  assert.ok(resp.error.includes('Upstream cluster error'));
});

test('chrome.runtime.onMessage listener handles GEMINI_NATIVE_REQUEST and returns success with grounding_metadata', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{
        content: { role: 'model', parts: [{ text: 'Response from runtime listener' }] },
        groundingMetadata: { webSearchQueries: ['search onMessage'] }
      }]
    })
  });

  let messageHandler = null;
  const mockChrome = {
    runtime: {
      onMessage: {
        addListener: (fn) => { messageHandler = fn; }
      }
    }
  };

  // Simulate onMessage registration
  mockChrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'GEMINI_NATIVE_REQUEST') {
      handleGeminiNativeRequest(message.payload || message, { fetchFn: fakeFetch })
        .then((result) => sendResponse({
          success: true,
          data: result,
          grounding_metadata: result?.candidates?.[0]?.groundingMetadata ?? null,
        }))
        .catch((err) => sendResponse({
          success: false,
          error: err.message,
        }));
      return true;
    }
  });

  const responsePromise = new Promise((resolve) => {
    const isAsync = messageHandler(
      { type: 'GEMINI_NATIVE_REQUEST', payload: { contents: [{ parts: [{ text: 'test' }] }] } },
      {},
      (reply) => resolve(reply)
    );
    assert.equal(isAsync, true, 'Handler must return true for async sendResponse');
  });

  const reply = await responsePromise;
  assert.equal(reply.success, true);
  assert.ok(reply.data);
  assert.deepEqual(reply.grounding_metadata.webSearchQueries, ['search onMessage']);
});

test('chrome.runtime.onMessage listener handles error gracefully', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: async () => JSON.stringify({ error: { message: 'Invalid credentials' } })
  });

  let messageHandler = null;
  const mockChrome = {
    runtime: {
      onMessage: {
        addListener: (fn) => { messageHandler = fn; }
      }
    }
  };

  mockChrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'GEMINI_NATIVE_REQUEST') {
      handleGeminiNativeRequest(message.payload || message, { fetchFn: fakeFetch })
        .then((result) => sendResponse({
          success: true,
          data: result,
        }))
        .catch((err) => sendResponse({
          success: false,
          error: err.message,
        }));
      return true;
    }
  });

  const responsePromise = new Promise((resolve) => {
    messageHandler(
      { type: 'GEMINI_NATIVE_REQUEST', payload: { contents: [{ parts: [{ text: 'test' }] }] } },
      {},
      (reply) => resolve(reply)
    );
  });

  const reply = await responsePromise;
  assert.equal(reply.success, false);
  assert.ok(reply.error.includes('Invalid credentials'));
});

// ─── 3. Protocol Message Types and Builders ───

test('protocol-messages exports GEMINI_NATIVE_REQUEST and GEMINI_NATIVE_RESPONSE in MessageTypes', () => {
  assert.equal(MessageTypes.GEMINI_NATIVE_REQUEST, 'GEMINI_NATIVE_REQUEST');
  assert.equal(MessageTypes.GEMINI_NATIVE_RESPONSE, 'GEMINI_NATIVE_RESPONSE');
});

test('buildGeminiNativeRequestMessage constructs valid protocol envelope', () => {
  const msg = buildGeminiNativeRequestMessage('req_test_3', { contents: [] }, 'notebook:nb1');
  assert.equal(msg.type, 'GEMINI_NATIVE_REQUEST');
  assert.equal(msg.requestId, 'req_test_3');
  assert.equal(msg.scope, 'notebook:nb1');
  assert.ok(msg.timestamp > 0);
});

test('buildGeminiNativeResponseMessage constructs response envelope with grounding_metadata', () => {
  const data = {
    candidates: [{ content: { parts: [{ text: 'hello' }] } }],
    grounding_metadata: { search_grounding: true }
  };
  const msg = buildGeminiNativeResponseMessage('req_test_4', data, true);
  assert.equal(msg.type, 'GEMINI_NATIVE_RESPONSE');
  assert.equal(msg.requestId, 'req_test_4');
  assert.equal(msg.success, true);
  assert.deepEqual(msg.grounding_metadata, { search_grounding: true });
});

test('getProtocolInfo advertises geminiNativeProtocol: true', () => {
  const info = getProtocolInfo();
  assert.equal(info.features.geminiNativeProtocol, true);
  assert.ok(info.messageTypes.includes('GEMINI_NATIVE_REQUEST'));
  assert.ok(info.messageTypes.includes('GEMINI_NATIVE_RESPONSE'));
});

// ─── 4. End-to-End Worker DO ↔ Extension Integration (KAN-355) ───

test('E2E: Worker POST /v1/gemini/chat/completions with Google Search Grounding through Extension', async () => {
  const worker = createMockWorker();
  const ext = await connectFakeExtension(worker, {
    onExecute: (msg) => {
      return {
        text: 'The population of Tokyo is approximately 14 million as of latest 2026 census.',
      };
    },
  });

  const payload = {
    model: 'gemini-3.5-flash-lite',
    contents: [{
      role: 'user',
      parts: [{ text: 'What is the current population of Tokyo?' }]
    }],
    tools: [{ google_search: {} }]
  };

  const res = await worker.fetch('/v1/gemini/chat/completions', {
    method: 'POST',
    headers: authHeaders(worker),
    body: JSON.stringify(payload)
  });

  assert.equal(res.status, 200);
  const data = await res.json();

  // Dual format assertions: OpenAI choices + Gemini candidates
  assert.ok(data.choices?.[0]?.message?.content?.includes('Tokyo'));
  assert.ok(data.candidates?.[0]?.content?.parts?.[0]?.text?.includes('Tokyo'));
  assert.equal(data.candidates[0].finishReason, 'STOP');

  // Search grounding metadata preserved
  assert.ok(data.grounding_metadata);
  assert.equal(data.grounding_metadata.search_grounding, true);
  assert.ok(Array.isArray(data.grounding_metadata.web_search_queries));

  ext.close();
});

test('E2E: Worker streaming SSE with Search Grounding yields chunks and candidate parts', async () => {
  const worker = createMockWorker();
  const ext = await connectFakeExtension(worker, {
    onExecute: () => ({ text: 'Streamed grounded Tokyo data' })
  });

  const payload = {
    contents: [{ role: 'user', parts: [{ text: 'Tell me about Tokyo' }] }],
    tools: [{ googleSearch: {} }],
    stream: true
  };

  const res = await worker.fetch('/v1/gemini/chat/completions', {
    method: 'POST',
    headers: authHeaders(worker),
    body: JSON.stringify(payload)
  });

  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type')?.includes('text/event-stream'));

  const text = await res.text();
  assert.ok(text.includes('chat.completion.chunk'));
  assert.ok(text.includes('Streamed grounded Tokyo data'));
  assert.ok(text.includes('candidates'));
  assert.ok(text.includes('[DONE]'));

  ext.close();
});

test('E2E: Feature flag rollback (GEMINI_NATIVE_ENABLED=false) degrades gracefully to 404', async () => {
  const worker = createMockWorker({
    env: { GEMINI_NATIVE_ENABLED: 'false' }
  });

  const res = await worker.fetch('/v1/gemini/chat/completions', {
    method: 'POST',
    headers: authHeaders(worker),
    body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] })
  });

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, 'gemini_native_disabled');
});

test('E2E: Disconnected extension fails-closed with 503 extension_disconnected', async () => {
  const worker = createMockWorker();
  worker.bridge.waitForExtension = async () => false;
  // No extension connected
  const res = await worker.fetch('/v1/gemini/chat/completions', {
    method: 'POST',
    headers: authHeaders(worker),
    body: JSON.stringify({ contents: [{ parts: [{ text: 'fail-closed check' }] }] })
  });

  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error.code, 'extension_disconnected');
});
