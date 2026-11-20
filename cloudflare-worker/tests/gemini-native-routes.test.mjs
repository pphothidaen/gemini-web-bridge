// ============================================================
// Tests for Gemini Native Routes & Search Grounding (KAN-351)
//
// Verifies:
// 1. Route availability and Bearer auth enforcement
// 2. /v1/gemini/models metadata and grounding capabilities
// 3. /v1/gemini/chat/completions accepts native body and tools: [{"google_search": {}}]
// 4. Feature flag GEMINI_NATIVE_ENABLED=false disables native routes
// 5. Normalization of contents, parts, and systemInstruction
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockWorker, connectFakeExtension } from './helpers/mock-worker.mjs';

const authHeaders = (worker) => ({
  Authorization: `Bearer ${worker.CLIENT_API_KEY}`,
  'Content-Type': 'application/json',
});

// ─── 1. Route Availability and Auth Requirement ───

test('GET /v1/gemini/models rejects unauthenticated requests with 401', async () => {
  const worker = createMockWorker();
  const res = await worker.fetch('/v1/gemini/models');
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, 'invalid_api_key');
});

test('GET /v1/gemini/models rejects invalid Bearer token with 401', async () => {
  const worker = createMockWorker();
  const res = await worker.fetch('/v1/gemini/models', {
    headers: { Authorization: 'Bearer wrong-key' },
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, 'invalid_api_key');
});

test('POST /v1/gemini/chat/completions rejects unauthenticated requests with 401', async () => {
  const worker = createMockWorker();
  const res = await worker.fetch('/v1/gemini/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: 'hello' }] }] }),
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, 'invalid_api_key');
});

test('POST /v1/gemini/chat/completions rejects invalid Bearer token with 401', async () => {
  const worker = createMockWorker();
  const res = await worker.fetch('/v1/gemini/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: 'hello' }] }] }),
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, 'invalid_api_key');
});

// ─── 2. /v1/gemini/models Grounding Capability Metadata ───

test('GET /v1/gemini/models returns grounding capability metadata', async () => {
  const worker = createMockWorker();
  const res = await worker.fetch('/v1/gemini/models', {
    headers: authHeaders(worker),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');

  const body = await res.json();
  assert.equal(body.object, 'list');
  assert.ok(Array.isArray(body.data));
  assert.equal(body.data.length, 2);

  const expected = {
    object: 'list',
    data: [
      {
        id: 'gemini-3.5-flash-lite',
        object: 'model',
        owned_by: 'google',
        capabilities: { grounding: true },
      },
      {
        id: 'gemini-3.1-pro-preview',
        object: 'model',
        owned_by: 'google',
        capabilities: { grounding: true },
      },
    ],
  };
  assert.deepEqual(body, expected);
});

// ─── 3. /v1/gemini/chat/completions Native Body & Search Grounding ───

test('POST /v1/gemini/chat/completions accepts native contents with tools: [{"google_search": {}}]', async () => {
  const worker = createMockWorker();
  const ext = await connectFakeExtension(worker, {
    onExecute: () => ({ text: 'The capital of Thailand is Bangkok. It has sunny weather today.' }),
  });

  const payload = {
    model: 'gemini-3.5-flash-lite',
    contents: [
      {
        role: 'user',
        parts: [{ text: 'What is the capital and current weather of Thailand?' }],
      },
    ],
    tools: [{ google_search: {} }],
  };

  const res = await worker.fetch('/v1/gemini/chat/completions', {
    method: 'POST',
    headers: authHeaders(worker),
    body: JSON.stringify(payload),
  });

  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.object, 'chat.completion');
  assert.ok(body.choices?.[0]?.message?.content?.includes('Bangkok'));
  assert.equal(body.model, 'gemini-3.5-flash-lite');

  // Verify search grounding metadata
  assert.ok(body.grounding_metadata, 'must include grounding_metadata');
  assert.equal(body.grounding_metadata.search_grounding, true);

  // Verify candidates format for Gemini native compatibility
  assert.ok(body.candidates?.[0]?.content?.parts?.[0]?.text?.includes('Bangkok'));

  ext.close();
});

test('POST /v1/gemini/chat/completions accepts OpenAI messages with tools: [{"google_search": {}}]', async () => {
  const worker = createMockWorker();
  const ext = await connectFakeExtension(worker, {
    onExecute: () => ({ text: 'Grounded web search response' }),
  });

  const payload = {
    model: 'gemini-3.1-pro-preview',
    messages: [{ role: 'user', content: 'Latest AI news 2026' }],
    tools: [{ google_search: {} }],
  };

  const res = await worker.fetch('/v1/gemini/chat/completions', {
    method: 'POST',
    headers: authHeaders(worker),
    body: JSON.stringify(payload),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices?.[0]?.message?.content, 'Grounded web search response');
  assert.equal(body.grounding_metadata?.search_grounding, true);

  ext.close();
});

test('POST /v1/gemini/chat/completions accepts camelCase tools: [{"googleSearch": {}}]', async () => {
  const worker = createMockWorker();
  const ext = await connectFakeExtension(worker, {
    onExecute: () => ({ text: 'CamelCase grounding acknowledged' }),
  });

  const payload = {
    contents: [{ role: 'user', parts: [{ text: 'Search query' }] }],
    tools: [{ googleSearch: {} }],
  };

  const res = await worker.fetch('/v1/gemini/chat/completions', {
    method: 'POST',
    headers: authHeaders(worker),
    body: JSON.stringify(payload),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices?.[0]?.message?.content, 'CamelCase grounding acknowledged');
  assert.equal(body.grounding_metadata?.search_grounding, true);

  ext.close();
});

test('POST /v1/gemini/chat/completions normalizes systemInstruction and string contents', async () => {
  const worker = createMockWorker();
  let receivedPrompt = '';
  const ext = await connectFakeExtension(worker, {
    onExecute: (msg) => {
      receivedPrompt = JSON.stringify(msg);
      return { text: 'System instruction processed' };
    },
  });

  const payload = {
    systemInstruction: { parts: [{ text: 'You are an astronomical expert.' }] },
    contents: 'Explain solar flares.',
    tools: [{ google_search: {} }],
  };

  const res = await worker.fetch('/v1/gemini/chat/completions', {
    method: 'POST',
    headers: authHeaders(worker),
    body: JSON.stringify(payload),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices?.[0]?.message?.content, 'System instruction processed');
  assert.ok(receivedPrompt.includes('astronomical expert'));
  assert.ok(receivedPrompt.includes('solar flares'));

  ext.close();
});

test('POST /v1/gemini/chat/completions supports streaming SSE with search grounding', async () => {
  const worker = createMockWorker();
  const ext = await connectFakeExtension(worker, {
    onExecute: () => ({ text: 'Streamed grounded answer' }),
  });

  const payload = {
    contents: [{ role: 'user', parts: [{ text: 'Stream test' }] }],
    tools: [{ google_search: {} }],
    stream: true,
  };

  const res = await worker.fetch('/v1/gemini/chat/completions', {
    method: 'POST',
    headers: authHeaders(worker),
    body: JSON.stringify(payload),
  });

  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type')?.includes('text/event-stream'));

  const text = await res.text();
  assert.ok(text.includes('chat.completion.chunk'));
  assert.ok(text.includes('Streamed grounded answer'));
  assert.ok(text.includes('data: [DONE]'));

  ext.close();
});

// ─── 4. Request Validation Ordering & Error Paths ───

test('POST /v1/gemini/chat/completions rejects empty contents and messages with 400', async () => {
  const worker = createMockWorker();
  const res = await worker.fetch('/v1/gemini/chat/completions', {
    method: 'POST',
    headers: authHeaders(worker),
    body: JSON.stringify({ contents: [] }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.message, /non-empty/i);
});

test('POST /v1/gemini/chat/completions rejects malformed JSON with 400', async () => {
  const worker = createMockWorker();
  const res = await worker.fetch('/v1/gemini/chat/completions', {
    method: 'POST',
    headers: authHeaders(worker),
    body: '{ bad json',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'bad_json');
});

test('POST /v1/gemini/chat/completions rejects non-array tools with 400', async () => {
  const worker = createMockWorker();
  const res = await worker.fetch('/v1/gemini/chat/completions', {
    method: 'POST',
    headers: authHeaders(worker),
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'query' }] }],
      tools: 'not-an-array',
    }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.message, /tools must be an array/i);
});

test('POST /v1/gemini/chat/completions returns 503 when extension is disconnected', async () => {
  const worker = createMockWorker();
  const res = await worker.fetch('/v1/gemini/chat/completions', {
    method: 'POST',
    headers: authHeaders(worker),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error.code, 'extension_disconnected');
});

// ─── 5. Feature Flag GEMINI_NATIVE_ENABLED=false Disables Routes ───

test('GEMINI_NATIVE_ENABLED="false" disables /v1/gemini/models with 404', async () => {
  const worker = createMockWorker({
    env: { GEMINI_NATIVE_ENABLED: 'false' },
  });
  const res = await worker.fetch('/v1/gemini/models', {
    headers: authHeaders(worker),
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, 'gemini_native_disabled');
});

test('GEMINI_NATIVE_ENABLED="false" disables /v1/gemini/chat/completions with 404', async () => {
  const worker = createMockWorker({
    env: { GEMINI_NATIVE_ENABLED: 'false' },
  });
  const res = await worker.fetch('/v1/gemini/chat/completions', {
    method: 'POST',
    headers: authHeaders(worker),
    body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }),
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, 'gemini_native_disabled');
});

test('GEMINI_NATIVE_ENABLED=false (boolean) disables routes with 404', async () => {
  const worker = createMockWorker({
    env: { GEMINI_NATIVE_ENABLED: false },
  });
  const res = await worker.fetch('/v1/gemini/models', {
    headers: authHeaders(worker),
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, 'gemini_native_disabled');
});

test('GEMINI_NATIVE_ENABLED="false" preserves existing OpenAI routes', async () => {
  const worker = createMockWorker({
    env: { GEMINI_NATIVE_ENABLED: 'false' },
  });
  // /v1/models must still return 200
  const modelsRes = await worker.fetch('/v1/models', {
    headers: authHeaders(worker),
  });
  assert.equal(modelsRes.status, 200);

  // /v1/chat/completions validation must still work
  const chatRes = await worker.fetch('/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(worker),
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(chatRes.status, 400);
});

// ─── 6. Additional Edge Cases & Robustness ───

test('POST /v1/gemini/chat/completions accepts single Content object in contents', async () => {
  const worker = createMockWorker();
  let receivedPrompt = '';
  const ext = await connectFakeExtension(worker, {
    onExecute: (msg) => {
      receivedPrompt = JSON.stringify(msg);
      return { text: 'Single content object processed' };
    },
  });

  const payload = {
    contents: {
      role: 'user',
      parts: [{ text: 'Single content object text' }],
    },
  };

  const res = await worker.fetch('/v1/gemini/chat/completions', {
    method: 'POST',
    headers: authHeaders(worker),
    body: JSON.stringify(payload),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices?.[0]?.message?.content, 'Single content object processed');
  assert.ok(receivedPrompt.includes('Single content object text'));

  ext.close();
});

test('POST /v1/gemini/chat/completions accepts Gemini-native functionDeclarations in tools', async () => {
  const worker = createMockWorker();
  let receivedPrompt = '';
  const ext = await connectFakeExtension(worker, {
    onExecute: (msg) => {
      receivedPrompt = JSON.stringify(msg);
      return { text: 'Tool declaration registered' };
    },
  });

  const payload = {
    contents: [{ role: 'user', parts: [{ text: 'Please read myfile.txt' }] }],
    tools: [
      {
        functionDeclarations: [
          {
            name: 'read_file',
            description: 'Read a file from disk',
            parameters: {
              type: 'object',
              properties: { file_path: { type: 'string' } },
              required: ['file_path'],
            },
          },
        ],
      },
    ],
  };

  const res = await worker.fetch('/v1/gemini/chat/completions', {
    method: 'POST',
    headers: authHeaders(worker),
    body: JSON.stringify(payload),
  });

  assert.equal(res.status, 200);
  assert.ok(receivedPrompt.includes('read_file'));

  ext.close();
});

test('POST /v1/gemini/chat/completions accepts mixed toolsets (google_search + functionDeclarations)', async () => {
  const worker = createMockWorker();
  let receivedPrompt = '';
  const ext = await connectFakeExtension(worker, {
    onExecute: (msg) => {
      receivedPrompt = JSON.stringify(msg);
      return { text: 'Mixed toolsets active' };
    },
  });

  const payload = {
    contents: [{ role: 'user', parts: [{ text: 'Search and read' }] }],
    tools: [
      { google_search: {} },
      {
        functionDeclarations: [
          {
            name: 'read_file',
            description: 'Read file',
            parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
          },
        ],
      },
    ],
  };

  const res = await worker.fetch('/v1/gemini/chat/completions', {
    method: 'POST',
    headers: authHeaders(worker),
    body: JSON.stringify(payload),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.grounding_metadata?.search_grounding, true);
  assert.ok(receivedPrompt.includes('Search Grounding'));
  assert.ok(receivedPrompt.includes('read_file'));

  ext.close();
});

test('POST /v1/gemini/chat/completions returns functionCall in candidates when tool is invoked', async () => {
  const worker = createMockWorker();
  const ext = await connectFakeExtension(worker, {
    onExecute: () => ({
      text: '<tool_call>\n{"name": "read_file", "arguments": {"file_path": "test.txt"}}\n</tool_call>',
    }),
  });

  const payload = {
    contents: [{ role: 'user', parts: [{ text: 'Read test.txt' }] }],
    tools: [
      {
        functionDeclarations: [
          {
            name: 'read_file',
            description: 'Read file',
            parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
          },
        ],
      },
    ],
  };

  const res = await worker.fetch('/v1/gemini/chat/completions', {
    method: 'POST',
    headers: authHeaders(worker),
    body: JSON.stringify(payload),
  });

  assert.equal(res.status, 200);
  const body = await res.json();

  // Verify OpenAI choices format
  assert.equal(body.choices?.[0]?.finish_reason, 'tool_calls');
  assert.equal(body.choices?.[0]?.message?.tool_calls?.[0]?.function?.name, 'read_file');

  // Verify Gemini native candidates format
  assert.equal(body.candidates?.[0]?.finishReason, 'TOOL_CALLS');
  assert.equal(body.candidates?.[0]?.content?.parts?.[0]?.functionCall?.name, 'read_file');
  assert.equal(body.candidates?.[0]?.content?.parts?.[0]?.functionCall?.args?.file_path, 'test.txt');

  ext.close();
});

test('POST /v1/gemini/chat/completions streaming SSE emits candidates in chunks', async () => {
  const worker = createMockWorker();
  const ext = await connectFakeExtension(worker, {
    onExecute: () => ({ text: 'Streamed part' }),
  });

  const payload = {
    contents: [{ role: 'user', parts: [{ text: 'Stream candidate test' }] }],
    tools: [{ google_search: {} }],
    stream: true,
  };

  const res = await worker.fetch('/v1/gemini/chat/completions', {
    method: 'POST',
    headers: authHeaders(worker),
    body: JSON.stringify(payload),
  });

  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('candidates'));
  assert.ok(text.includes('Streamed part'));

  ext.close();
});

test('GEMINI_NATIVE_ENABLED="false" rejects requests with 404 BEFORE checking auth', async () => {
  const worker = createMockWorker({
    env: { GEMINI_NATIVE_ENABLED: 'false' },
  });
  // Request without ANY Authorization header
  const res = await worker.fetch('/v1/gemini/models');
  assert.equal(res.status, 404, 'Must return 404 rather than 401 when feature is disabled');
  const body = await res.json();
  assert.equal(body.error.code, 'gemini_native_disabled');
});

test('GEMINI_NATIVE_ENABLED values: "0", "off", "no" all disable routes', async () => {
  for (const disabledVal of ['0', 'off', 'no']) {
    const worker = createMockWorker({
      env: { GEMINI_NATIVE_ENABLED: disabledVal },
    });
    const res = await worker.fetch('/v1/gemini/models');
    assert.equal(res.status, 404, `Value '${disabledVal}' must disable routes`);
    const body = await res.json();
    assert.equal(body.error.code, 'gemini_native_disabled');
  }
});

test('POST /v1/gemini/chat/completions accepts google_search_retrieval tool', async () => {
  const worker = createMockWorker();
  const ext = await connectFakeExtension(worker, {
    onExecute: () => ({ text: 'Search retrieval grounded' }),
  });

  const payload = {
    contents: [{ role: 'user', parts: [{ text: 'Search retrieval query' }] }],
    tools: [{ google_search_retrieval: {} }],
  };

  const res = await worker.fetch('/v1/gemini/chat/completions', {
    method: 'POST',
    headers: authHeaders(worker),
    body: JSON.stringify(payload),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.grounding_metadata?.search_grounding, true);

  ext.close();
});
