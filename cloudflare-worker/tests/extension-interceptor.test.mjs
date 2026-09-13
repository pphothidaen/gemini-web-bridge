import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../extension-cloudflare/injected.js', import.meta.url), 'utf8');

function setupSandbox(customFetch = null) {
  const postedMessages = [];
  const fetchCalls = [];
  const handlers = {};

  const fakeWindow = {
    location: { href: 'https://gemini.google.com/app' },
    WIZ_global_data: {
      SNlM0e: 'test_csrf_token_xyz',
      cfb2h: 'boq_test_build_label_2026',
      o_u: 'acc_test_456'
    },
    addEventListener: (name, fn) => { handlers[name] = fn; },
    postMessage: (data) => { postedMessages.push(data); },
    fetch: customFetch || (async (url, init) => {
      fetchCalls.push({ url, init });
      return {
        ok: true,
        status: 200,
        clone: () => ({
          body: {
            getReader: () => ({
              read: async () => ({ value: new TextEncoder().encode(")]}'\n[['wrb.fr',null,'test_chunk']]") })
            })
          }
        }),
        body: {
          getReader: () => {
            let done = false;
            return {
              read: async () => {
                if (!done) {
                  done = true;
                  return { done: false, value: new TextEncoder().encode(")]}'\n[['wrb.fr',null,'test_chunk']]") };
                }
                return { done: true };
              }
            };
          }
        }
      };
    })
  };

  class FakeXMLHttpRequest {
    constructor() {
      this.headers = {};
      this.listeners = {};
    }
    open(method, url) { this.url = url; }
    setRequestHeader(k, v) { this.headers[k.toLowerCase()] = v; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    send(body) {
      this.body = body;
      this.status = 200;
      this.responseText = ")]}'\n[['wrb.fr',null,'test_chunk']]";
      this.listeners['loadend']?.();
    }
  }

  const sandbox = {
    window: fakeWindow,
    document: {},
    console: { log() {}, warn() {}, error() {} },
    fetch: fakeWindow.fetch,
    XMLHttpRequest: FakeXMLHttpRequest,
    AbortController,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    setInterval: () => 1,
    clearInterval: () => {},
    postedMessages,
    fetchCalls,
    handlers
  };

  vm.runInNewContext(source, sandbox);
  return sandbox;
}

test('injected script broadcasts SESSION_STATE without leaking CSRF token', () => {
  const sandbox = setupSandbox();
  const sessionMsg = sandbox.postedMessages.find(m => m.type === 'SESSION_STATE');
  assert.ok(sessionMsg);
  assert.equal(sessionMsg.payload.sessionReady, true);
  assert.equal(sessionMsg.payload.buildLabel, 'boq_test_build_label_2026');
  assert.ok(sessionMsg.payload.sessionEpoch);
  // Assert Google CSRF token is kept private in MAIN world and NOT broadcast
  assert.equal(sessionMsg.payload.at, undefined);
  assert.equal(sessionMsg.payload.SNlM0e, undefined);
});

test('early interceptor captures native Gemini fetch and posts qualified NATIVE_RPC_OBSERVED', async () => {
  const sandbox = setupSandbox();

  // Set active canonical model
  await sandbox.handlers['message']({
    source: sandbox.window,
    data: {
      source: 'GEMINI_CONTENT',
      type: 'CANONICAL_MODEL_UPDATED',
      payload: { modelId: 'gemini-3.8-flash' }
    }
  });

  const nativeUrl = 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq_test_bl';
  await sandbox.window.fetch(nativeUrl, {
    method: 'POST',
    body: 'f.req=' + encodeURIComponent(JSON.stringify([null, JSON.stringify(['prompt_text'])]))
  });

  // Allow async reader microtasks to settle
  await new Promise(r => setTimeout(r, 20));

  const observed = sandbox.postedMessages.find(m => m.type === 'NATIVE_RPC_OBSERVED');
  assert.ok(observed);
  assert.equal(observed.evidence.endpoint, 'StreamGenerate');
  assert.equal(observed.evidence.buildLabel, 'boq_test_bl');
  assert.equal(observed.evidence.canonicalModelId, 'gemini-3.8-flash');
  assert.equal(observed.evidence.responseVerified, true);
});

test('early interceptor ignores calls outside Gemini recognized endpoints', async () => {
  const sandbox = setupSandbox();
  const initialObservedCount = sandbox.postedMessages.filter(m => m.type === 'NATIVE_RPC_OBSERVED').length;

  // External URL
  await sandbox.window.fetch('https://example.com/api', {
    method: 'POST',
    body: 'f.req=test'
  });

  // Non-Gemini internal path
  await sandbox.window.fetch('https://gemini.google.com/other/path', {
    method: 'POST',
    body: 'f.req=test'
  });

  const afterCount = sandbox.postedMessages.filter(m => m.type === 'NATIVE_RPC_OBSERVED').length;
  assert.equal(afterCount, initialObservedCount);
});

test('EXECUTE_STREAM executes request cleanly without sending custom x-bridge-replay header to Google', async () => {
  const sandbox = setupSandbox();

  await sandbox.handlers['message']({
    source: sandbox.window,
    data: {
      source: 'GEMINI_CONTENT',
      type: 'EXECUTE_STREAM',
      requestId: 'req_12345',
      payload: { f_req: JSON.stringify([null, '["test"]']) }
    }
  });

  assert.ok(sandbox.fetchCalls.length > 0);
  const bridgeCall = sandbox.fetchCalls.at(-1);

  // Review requirement: do NOT send custom x-bridge-replay header to Google!
  assert.equal(bridgeCall.init?.headers?.['x-bridge-replay'], undefined);
  assert.equal(bridgeCall.init?.headers?.['X-Bridge-Replay'], undefined);

  // Verify stream chunk and done
  const chunkMsg = sandbox.postedMessages.find(m => m.type === 'STREAM_CHUNK' && m.requestId === 'req_12345');
  assert.ok(chunkMsg);

  const doneMsg = sandbox.postedMessages.find(m => m.type === 'STREAM_DONE' && m.requestId === 'req_12345');
  assert.ok(doneMsg);
});

test('CANCEL_STREAM aborts in-flight execution and posts cancelled STREAM_ERROR', async () => {
  const abortableFetch = (url, init) => {
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };

  const sandbox = setupSandbox(abortableFetch);

  const execPromise = sandbox.handlers['message']({
    source: sandbox.window,
    data: {
      source: 'GEMINI_CONTENT',
      type: 'EXECUTE_STREAM',
      requestId: 'req_cancel_test',
      payload: { f_req: '[]' }
    }
  });

  await sandbox.handlers['message']({
    source: sandbox.window,
    data: {
      source: 'GEMINI_CONTENT',
      type: 'CANCEL_STREAM',
      requestId: 'req_cancel_test'
    }
  });

  await execPromise;

  const errorMsg = sandbox.postedMessages.find(m => m.type === 'STREAM_ERROR' && m.requestId === 'req_cancel_test');
  assert.ok(errorMsg);
  assert.equal(errorMsg.code, 'cancelled');
});
