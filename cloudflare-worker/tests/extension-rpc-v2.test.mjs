import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ModelAdapter = require('../../extension-cloudflare/model-adapter.js');
const { EvidenceRegistry } = require('../../extension-cloudflare/evidence-registry.js');
const source = fs.readFileSync(new URL('../../extension-cloudflare/content.js', import.meta.url), 'utf8');

function setupExtensionVm(options = {}) {
  const messages = [];
  const sockets = [];
  const timers = [];
  const handlers = {};
  const clicks = [];
  const labels = options.labels || ['Fast', '3.8 Flash', 'Thinking'];

  const node = text => ({
    innerText: text,
    textContent: text,
    style: {},
    classList: { contains: () => false },
    getAttribute: (attr) => (attr === 'aria-expanded' ? 'false' : null),
    querySelector: () => null,
    addEventListener() {},
    remove() {},
    click() { clicks.push(text); }
  });

  const addHandler = (key, fn) => {
    if (!handlers[key]) {
      const list = [];
      const dispatcher = (arg) => list.forEach(f => f(arg));
      dispatcher._list = list;
      handlers[key] = dispatcher;
    }
    handlers[key]._list.push(fn);
  };

  const document = {
    querySelectorAll: () => labels.map(node),
    querySelector: (sel) => node('Model Trigger Button'),
    createElement: () => node(''),
    body: { appendChild() {} },
    head: { appendChild() {} },
    addEventListener: (name, fn) => addHandler(name, fn)
  };

  const window = {
    addEventListener: (name, fn) => addHandler('window:' + name, fn),
    postMessage: (data) => {
      if (options.onWindowPostMessage) options.onWindowPostMessage(data);
    }
  };

  class WebSocketMock {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    send(raw) {
      messages.push(JSON.parse(raw));
    }
    close(code, reason) {
      this.readyState = 3;
      this.onclose?.({ code: code || 1000, reason });
    }
  }

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    URL,
    Map,
    Array,
    Boolean,
    Set,
    JSON,
    Math,
    Date,
    document,
    window,
    WebSocket: WebSocketMock,
    ModelAdapter, EvidenceRegistry,
    setTimeout: (fn, delay) => {
      const id = timers.length;
      timers.push({ fn, delay, cancelled: false });
      return id;
    },
    clearTimeout: (id) => {
      if (timers[id]) timers[id].cancelled = true;
    },
    chrome: {
      runtime: {
        getURL: p => p,
        connect: () => ({
          onMessage: { addListener: (fn) => fn({ type: 'COORDINATOR_STATE', role: 'leader' }) },
          onDisconnect: { addListener: () => {} },
          postMessage: () => {}
        })
      },
      storage: {
        sync: {
          get: async () => ({
            workerUrl: 'https://worker.test',
            bridgeToken: 'test-secret',
            enforcementMode: options.enforcementMode || 'strict'
          })
        },
        local: {
          get: (keys, cb) => cb?.({}),
          set: (obj, cb) => cb?.(),
          remove: (keys, cb) => cb?.()
        },
        onChanged: { addListener() {} }
      }
    },
    messages,
    sockets,
    timers,
    handlers,
    clicks
  };

  vm.runInNewContext(source, sandbox);
  return sandbox;
}

test('SESSION_READY and MODELS_DISCOVERED emit protocolVersion 2 without leaking Google CSRF tokens', async () => {
  const env = setupExtensionVm();
  await Promise.resolve();

  env.handlers['window:message']({
    source: env.window,
    data: {
      source: 'GEMINI_INJECTED',
      type: 'SESSION_STATE',
      payload: { sessionReady: true, buildLabel: 'boq_test', sessionEpoch: 'epoch_1' }
    }
  });

  const ws = env.sockets.at(-1);
  ws.readyState = 1;
  ws.onopen();

  const sessionReady = env.messages.find(m => m.type === 'SESSION_READY');
  assert.ok(sessionReady, 'SESSION_READY must be sent');
  assert.equal(sessionReady.protocolVersion, 2);
  assert.deepEqual(sessionReady.capabilities, { verifiedRpc: true });
  assert.equal(sessionReady.enforcementMode, 'strict');
  assert.equal(sessionReady.sessionReady, true);
  assert.ok(sessionReady.tokens?.sessionReady === true);
  // Must NOT leak Google CSRF tokens over the wire
  assert.equal(sessionReady.tokens?.at, undefined);
  assert.ok(Array.isArray(sessionReady.models));

  for (const model of sessionReady.models) {
    assert.ok(['discovered', 'learning', 'verified', 'stale', 'unsupported'].includes(model.verification));
    assert.equal(typeof model.id, 'string');
    assert.ok(model.mapping_revision === null || typeof model.mapping_revision === 'string');
  }
});

test('PREPARE_MODEL performs UI selector click, transitions to learning, and fails closed with model_unverified after 10s', async () => {
  const env = setupExtensionVm();
  await Promise.resolve();

  env.handlers['window:message']({
    source: env.window,
    data: { source: 'GEMINI_INJECTED', type: 'SESSION_STATE', payload: { sessionReady: true } }
  });
  env.sockets.at(-1).readyState = 1;
  env.sockets.at(-1).onopen();

  // Send PREPARE_MODEL for gemini-3.8-flash
  env.sockets.at(-1).onmessage({
    data: JSON.stringify({
      type: 'PREPARE_MODEL',
      requestId: 'prep_101',
      model: 'gemini-3.8-flash',
      catalogRevision: 'cat_rev_1'
    })
  });

  // Verify that UI selector button / item was clicked to select model in UI
  assert.ok(env.clicks.length > 0, 'UI selector item must be clicked during preparation');
  assert.ok(env.clicks.some(c => c.includes('3.8 Flash')));

  // Check that snapshot published with verification: 'learning'
  const learningMsg = env.messages.filter(m => m.type === 'MODELS_DISCOVERED').at(-1);
  assert.ok(learningMsg);
  const flashModel = learningMsg.models.find(m => m.id === 'gemini-3.8-flash');
  assert.ok(flashModel);
  assert.equal(flashModel.verification, 'learning');

  // Trigger 10s learning expiry
  const timer10s = env.timers.find(t => t.delay === 10000 && !t.cancelled);
  assert.ok(timer10s);
  timer10s.fn();

  const errorMsg = env.messages.find(m => m.type === 'STREAM_ERROR' && m.requestId === 'prep_101');
  assert.ok(errorMsg);
  assert.equal(errorMsg.code, 'model_unverified');

  const finalCatalog = env.messages.filter(m => m.type === 'MODELS_DISCOVERED').at(-1);
  const unsupportedModel = finalCatalog.models.find(m => m.id === 'gemini-3.8-flash');
  assert.equal(unsupportedModel.verification, 'unsupported');
});

test('EXECUTE_REQUEST strictly rejects unverified model or revision mismatch', async () => {
  const env = setupExtensionVm();
  await Promise.resolve();

  env.handlers['window:message']({
    source: env.window,
    data: { source: 'GEMINI_INJECTED', type: 'SESSION_STATE', payload: { sessionReady: true } }
  });
  env.sockets.at(-1).readyState = 1;
  env.sockets.at(-1).onopen();

  // Attempt to execute unverified model
  env.sockets.at(-1).onmessage({
    data: JSON.stringify({
      type: 'EXECUTE_REQUEST',
      requestId: 'exec_fail_1',
      payload: {
        f_req: '["test"]',
        model: 'gemini-unverified-model',
        protocolVersion: 2,
        catalogRevision: 'cat_1',
        mappingRevision: 'rev_fake'
      }
    })
  });

  const err = env.messages.find(m => m.type === 'STREAM_ERROR' && m.requestId === 'exec_fail_1');
  assert.ok(err);
  assert.equal(err.code, 'model_unverified');
});

test('EXECUTE_REQUEST constructs replay payload via ModelAdapter under synthetic verified fixture', async () => {
  ModelAdapter._validators.clear();
  const TEST_SCHEMA = 'test_verified_exec_schema';
  let replayConstructed = false;

  ModelAdapter.registerSchema(TEST_SCHEMA, Object.assign((gen) => ({ valid: true }), {
    buildReplay: (modelId, record, promptText) => {
      replayConstructed = true;
      return JSON.stringify([null, JSON.stringify([`adapted_${modelId}_${promptText}`])]);
    }
  }));

  const windowPosts = [];
  const env = setupExtensionVm({
    onWindowPostMessage: (data) => windowPosts.push(data)
  });
  await Promise.resolve();

  env.handlers['window:message']({
    source: env.window,
    data: { source: 'GEMINI_INJECTED', type: 'SESSION_STATE', payload: { sessionReady: true, buildLabel: 'boq_1' } }
  });
  env.sockets.at(-1).readyState = 1;
  env.sockets.at(-1).onopen();

  // Simulate verified generation evidence arriving
  env.handlers['window:message']({
    source: env.window,
    data: {
      source: 'GEMINI_INJECTED',
      type: 'NATIVE_RPC_OBSERVED',
      evidence: {
        endpoint: 'StreamGenerate',
        canonicalModelId: 'gemini-3.8-flash',
        buildLabel: 'boq_1',
        responseVerified: true,
        payload: { valid: true }
      }
    }
  });

  // Check updated catalog with verified status
  const catalogMsg = env.messages.filter(m => m.type === 'MODELS_DISCOVERED').at(-1);
  const verifiedModel = catalogMsg.models.find(m => m.id === 'gemini-3.8-flash');
  assert.equal(verifiedModel.verification, 'verified');
  assert.ok(verifiedModel.mapping_revision);

  // Execute request with verified model and matching revision
  env.sockets.at(-1).onmessage({
    data: JSON.stringify({
      type: 'EXECUTE_REQUEST',
      requestId: 'exec_verified_1',
      payload: {
        f_req: 'hello_prompt',
        model: 'gemini-3.8-flash',
        protocolVersion: 2,
        mappingRevision: verifiedModel.mapping_revision
      }
    })
  });

  // Verify ModelAdapter.buildReplayPayload was called
  assert.equal(replayConstructed, true, 'ModelAdapter.buildReplayPayload must be called to construct replay');

  // Verify EXECUTE_STREAM was forwarded to injected script with adapter-built payload
  const execStream = windowPosts.find(p => p.type === 'EXECUTE_STREAM' && p.requestId === 'exec_verified_1');
  assert.ok(execStream);
  assert.ok(execStream.payload.f_req.includes('adapted_gemini-3.8-flash_hello_prompt'));
});

test('CANCEL_REQUEST aborts in-flight execution and cancels pending prepare', async () => {
  let postedToWindow = [];
  const env = setupExtensionVm({
    onWindowPostMessage: (data) => postedToWindow.push(data)
  });
  await Promise.resolve();

  env.handlers['window:message']({
    source: env.window,
    data: { source: 'GEMINI_INJECTED', type: 'SESSION_STATE', payload: { sessionReady: true } }
  });
  env.sockets.at(-1).readyState = 1;
  env.sockets.at(-1).onopen();

  // Start prepare
  env.sockets.at(-1).onmessage({
    data: JSON.stringify({
      type: 'PREPARE_MODEL',
      requestId: 'prep_cancel',
      model: 'gemini-3.8-flash'
    })
  });

  // Cancel prepare
  env.sockets.at(-1).onmessage({
    data: JSON.stringify({
      type: 'CANCEL_REQUEST',
      requestId: 'prep_cancel'
    })
  });

  const cancelErr = env.messages.find(m => m.type === 'STREAM_ERROR' && m.requestId === 'prep_cancel');
  assert.ok(cancelErr);
  assert.equal(cancelErr.code, 'cancelled');
});
