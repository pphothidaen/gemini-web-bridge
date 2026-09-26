import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ModelAdapter = require('../../extension-cloudflare/model-adapter.js');
const { EvidenceRegistry, sanitizeEvidence, sanitizeStructure } = require('../../extension-cloudflare/evidence-registry.js');

test('evidence sanitizer strips prompts, responses, cookies, and tokens', () => {
  const raw = {
    endpoint: '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=123#frag',
    buildLabel: 'boq_assistant-bard-web-server_20260901.00_p0',
    canonicalModelId: 'gemini-3.8-flash',
    timestamp: Date.now(),
    payload: {
      prompt: 'Classified secret prompt text',
      response: 'Generated response text',
      at: 'SNlM0e_secret_token_12345',
      cookie: 'SID=secret_cookie_value',
      nested: [
        'User prompt string that is private',
        123,
        true,
        {
          auth_token: 'should_be_stripped',
          model: 'gemini-3.8-flash'
        }
      ]
    }
  };

  const sanitized = sanitizeEvidence(raw);
  const serialized = JSON.stringify(sanitized);

  // Assert sensitive strings are never present in sanitized output
  assert.equal(serialized.includes('Classified secret prompt text'), false);
  assert.equal(serialized.includes('Generated response text'), false);
  assert.equal(serialized.includes('SNlM0e_secret_token_12345'), false);
  assert.equal(serialized.includes('SID=secret_cookie_value'), false);
  assert.equal(serialized.includes('should_be_stripped'), false);
  assert.equal(serialized.includes('User prompt string that is private'), false);

  // Endpoint is stripped of queries and fragments
  assert.equal(sanitized.endpoint, '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate');
  assert.equal(sanitized.buildLabel, 'boq_assistant-bard-web-server_20260901.00_p0');
  assert.equal(sanitized.canonicalModelId, 'gemini-3.8-flash');
  assert.equal(sanitized.structuralSignature.type, 'object');
});

test('cached records load from storage as stale until re-validated', async () => {
  const mockStorage = {
    data: {
      gemini_evidence_registry: {
        version: 2,
        lastBuildLabel: 'build_v1',
        lastAccountHash: 'acc_123',
        records: {
          'gemini-3.8-flash': {
            modelId: 'gemini-3.8-flash',
            verification: 'verified',
            mappingRevision: 'rev_abc123',
            schemaId: 'test_schema',
            updatedAt: Date.now()
          }
        }
      }
    },
    get(keys, cb) { cb({ gemini_evidence_registry: this.data.gemini_evidence_registry }); },
    set(obj, cb) { Object.assign(this.data, obj); cb?.(); }
  };

  const registry = new EvidenceRegistry(mockStorage);
  await registry.init('build_v1', 'acc_123');

  const status = registry.getModelStatus('gemini-3.8-flash');
  // Must be marked STALE on load from cache
  assert.equal(status.verification, 'stale');
});

test('build label or account change immediately invalidates cached mappings', async () => {
  const mockStorage = {
    data: {
      gemini_evidence_registry: {
        version: 2,
        lastBuildLabel: 'build_v1',
        lastAccountHash: 'acc_123',
        records: {
          'gemini-3.8-flash': {
            modelId: 'gemini-3.8-flash',
            verification: 'verified',
            mappingRevision: 'rev_abc123',
            schemaId: 'test_schema',
            updatedAt: Date.now()
          }
        }
      }
    },
    get(keys, cb) { cb({ gemini_evidence_registry: this.data.gemini_evidence_registry }); },
    set(obj, cb) { Object.assign(this.data, obj); cb?.(); }
  };

  const registry = new EvidenceRegistry(mockStorage);
  // Initialize with different build label (e.g. Google deployed a new web build)
  await registry.init('build_v2_new', 'acc_123');

  const status = registry.getModelStatus('gemini-3.8-flash');
  assert.equal(status.verification, 'stale');
  assert.equal(status.mappingRevision, null);
  assert.equal(status.record.invalidatedReason, 'build_label_changed');
});

test('REGRESSION: old generation evidence cannot be revived by selector evidence or across reconnect/invalidation', async () => {
  ModelAdapter._validators.clear();
  const TEST_SCHEMA_ID = 'regression_test_schema';
  ModelAdapter.registerSchema(TEST_SCHEMA_ID, Object.assign((gen, modelId) => {
    if (gen?.structuralSignature?.type === 'object') {
      return { valid: true, sanitizedStructure: { schema: TEST_SCHEMA_ID } };
    }
    return { valid: false };
  }, {
    buildReplay: () => ({ f_req: 'replayed' })
  }));

  const registry = new EvidenceRegistry();
  await registry.init('build_1', 'acc_1');

  // Step 1: Model is verified with valid generation evidence in current session
  registry.recordGenerationEvidence('gemini-3.8-flash', {
    endpoint: 'StreamGenerate',
    buildLabel: 'build_1',
    sessionEpoch: registry.currentSessionEpoch,
    responseVerified: true,
    payload: { validObject: true }
  });

  let status = registry.getModelStatus('gemini-3.8-flash');
  assert.equal(status.verification, 'verified');
  assert.ok(status.mappingRevision);

  // Step 2: Session is invalidated (e.g. build change or reconnect)
  registry.invalidateAll('reconnect');
  status = registry.getModelStatus('gemini-3.8-flash');
  assert.equal(status.verification, 'stale');
  assert.equal(status.mappingRevision, null);

  // Step 3: Fresh selector evidence arrives for the model
  registry.recordSelectorEvidence('gemini-3.8-flash', {
    endpoint: 'ModelSelector',
    payload: { selected: true }
  });

  // VERIFY: The model must NOT be revived to verified! Generation evidence was cleared.
  status = registry.getModelStatus('gemini-3.8-flash');
  assert.notEqual(status.verification, 'verified');
  assert.equal(status.mappingRevision, null);
});

test('unknown schema generation evidence fails closed as unsupported', () => {
  ModelAdapter._validators.clear();
  const registry = new EvidenceRegistry();
  const rawUnknownGen = {
    endpoint: 'StreamGenerate',
    buildLabel: 'build_2026',
    timestamp: Date.now(),
    responseVerified: true,
    payload: {
      unknownFormat: [1, 2, 3],
      nonStandardEnvelope: true
    }
  };

  registry.recordGenerationEvidence('gemini-random-model', rawUnknownGen);
  const status = registry.getModelStatus('gemini-random-model');

  assert.equal(status.verification, 'unsupported');
  assert.equal(status.mappingRevision, null);
});

test('structural adapter with verified fixture successfully promotes model to verified', () => {
  ModelAdapter._validators.clear();
  const TEST_SCHEMA_ID = 'proven_test_gemini_stream_generate_v1';
  ModelAdapter.registerSchema(TEST_SCHEMA_ID, Object.assign((gen, modelId) => {
    const sig = gen.structuralSignature;
    if (gen.endpoint === 'StreamGenerate' && sig?.type === 'object') {
      return {
        valid: true,
        sanitizedStructure: { schema: TEST_SCHEMA_ID, modelId }
      };
    }
    return { valid: false };
  }, {
    buildReplay: (modelId, verifiedRecord, promptText) => {
      return JSON.stringify([null, JSON.stringify([[[promptText, 0, null, null, null, null, 0], ['en'], [modelId]]])]);
    }
  }));

  const registry = new EvidenceRegistry();
  const validFixtureEvidence = {
    endpoint: 'StreamGenerate',
    buildLabel: 'boq_20260901',
    timestamp: Date.now(),
    responseVerified: true,
    payload: {
      f_req: ['prompt_placeholder', 'en', ['session_state'], null, [1]]
    }
  };

  registry.recordGenerationEvidence('gemini-3.8-flash', validFixtureEvidence);
  const status = registry.getModelStatus('gemini-3.8-flash');

  assert.equal(status.verification, 'verified');
  assert.ok(typeof status.mappingRevision === 'string' && status.mappingRevision.startsWith('rev_'));

  // Test replay builder produces verified output
  const replay = ModelAdapter.buildReplayPayload('gemini-3.8-flash', status.mappingRevision, status.record, 'Hello world');
  assert.ok(replay.f_req.includes('Hello world'));
  assert.ok(replay.f_req.includes('gemini-3.8-flash'));
});

test('exportSanitizedEvidence provides structural signatures without prompts or tokens', () => {
  ModelAdapter._validators.clear();
  const registry = new EvidenceRegistry();
  registry.recordGenerationEvidence('gemini-3.8-flash', {
    endpoint: 'StreamGenerate',
    buildLabel: 'boq_20260901',
    responseVerified: true,
    payload: { field: 123 }
  });

  const exported = registry.exportSanitizedEvidence();
  assert.ok(exported.models['gemini-3.8-flash']);
  const serialized = JSON.stringify(exported);
  assert.equal(serialized.includes('SNlM0e'), false);
  assert.equal(serialized.includes('prompt'), false);
});

test('saveToStorage defers writes until init completes and flushes pending writes', async () => {
  ModelAdapter._validators.clear();
  ModelAdapter.registerSchema('test_verified_exec_schema', Object.assign((gen) => ({
    valid: true,
    sanitizedStructure: { schema: 'test_verified_exec_schema', modelId: gen?.modelId || 'test' }
  }), {
    buildReplay: () => '[]'
  }));

  let writeCalls = 0;
  let writePayload = null;
  const mockStorage = {
    get: (keys, cb) => cb({}),
    set: (obj, cb) => { writeCalls++; writePayload = obj; cb?.(); },
    remove: (keys, cb) => cb?.()
  };

  const registry = new EvidenceRegistry(mockStorage);
  assert.equal(registry.initialized, false);

  // Register evidence BEFORE init() resolves – saveToStorage should be deferred.
  registry.recordGenerationEvidence('gemini-3.8-flash', {
    endpoint: 'StreamGenerate',
    buildLabel: 'boq_test',
    sessionEpoch: registry.currentSessionEpoch,
    responseVerified: true,
    requestSignature: { hasEnvelope: true, outerLength: 2, structure: [] }
  });

  // No write should have been attempted yet because init() is not complete.
  assert.equal(writeCalls, 0);
  assert.equal(registry._hasPendingWrites, true);

  // Complete init() — this should flush the deferred write.
  await registry.init('boq_test', 'acc_123');

  assert.equal(registry.initialized, true);
  assert.equal(registry._hasPendingWrites, false);
  assert.equal(writeCalls, 1);
  assert.ok(writePayload, 'pending write payload should have been flushed');
  assert.ok(writePayload.gemini_evidence_registry, 'payload should contain registry data');
  assert.equal(writePayload.gemini_evidence_registry.records['gemini-3.8-flash'].verification, 'verified');
});

test('saveToStorage treats context-invalidation as PERMANENT (orphaned), silent, no retry', async () => {
  ModelAdapter._validators.clear();
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warns.push(args); };
  let setCalls = 0;
  const mockStorage = {
    get: (keys, cb) => cb({}),
    set: (_obj, cb) => { setCalls++; cb?.(); },
    remove: (keys, cb) => cb?.()
  };
  const originalChrome = typeof chrome !== 'undefined' ? chrome : undefined;
  globalThis.chrome = { runtime: { id: 'live-id', lastError: { message: 'Extension context invalidated' } }, storage: { local: mockStorage } };
  const registry = new EvidenceRegistry(mockStorage);
  await registry.init();
  registry.recordGenerationEvidence('gemini-3.8-flash', {
    endpoint: 'StreamGenerate',
    buildLabel: 'boq_test',
    sessionEpoch: registry.currentSessionEpoch,
    responseVerified: true,
    requestSignature: { hasEnvelope: true, outerLength: 2, structure: [] }
  });
  // record*() fires saveToStorage() without awaiting it — wait for the
  // callback-driven orphan detection before asserting.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(registry.isOrphaned(), true);
  assert.equal(registry._hasPendingWrites, true);
  assert.deepEqual(warns, [], 'orphaned save must not log');
  const callsAfterFirst = setCalls;
  await registry.saveToStorage();
  assert.equal(setCalls, callsAfterFirst, 'orphaned short-circuits before storage');
  console.warn = originalWarn;
  if (originalChrome === undefined) { delete globalThis.chrome; }
  else { globalThis.chrome = originalChrome; }
});

test('saveToStorage treats timeout as TRANSIENT (silent, sets pending)', async () => {
  ModelAdapter._validators.clear();
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warns.push(args); };
  const originalChrome = typeof chrome !== 'undefined' ? chrome : undefined;
  globalThis.chrome = { runtime: { id: 'live-id' }, storage: {} };
  const mockStorage = {
    get: (keys, cb) => cb({}),
    set: (_obj, _cb) => { /* never calls back: forces 1s Storage timeout */ },
    remove: (keys, cb) => cb?.()
  };
  const registry = new EvidenceRegistry(mockStorage);
  await registry.init();
  registry.recordGenerationEvidence('gemini-3.8-flash', {
    endpoint: 'StreamGenerate',
    buildLabel: 'boq_test',
    sessionEpoch: registry.currentSessionEpoch,
    responseVerified: true,
    requestSignature: { hasEnvelope: true, outerLength: 2, structure: [] }
  });
  // record*() fires saveToStorage() without awaiting it; the 1s storage
  // timeout resolves asynchronously — wait for it before asserting.
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(registry.isOrphaned(), false);
  assert.equal(registry._hasPendingWrites, true);
  assert.deepEqual(warns, [], 'transient timeout must not warn');
  console.warn = originalWarn;
  if (originalChrome === undefined) { delete globalThis.chrome; }
  else { globalThis.chrome = originalChrome; }
});

test('init() with dead context restores snapshot silently and never flushes', async () => {
  ModelAdapter._validators.clear();
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warns.push(args); };
  const originalChrome = typeof chrome !== 'undefined' ? chrome : undefined;
  let flushSetCalls = 0;
  const mockStorage = {
    get: (_keys, _cb) => { throw new Error('Extension context invalidated'); },
    set: (_obj, cb) => { flushSetCalls++; cb?.(); },
    remove: (keys, cb) => cb?.()
  };
  globalThis.chrome = { runtime: {}, storage: { local: mockStorage } };
  const registry = new EvidenceRegistry(mockStorage);
  registry.records.set('pre-existing', { modelId: 'pre-existing', verification: 'verified', mappingRevision: 'rev_1' });
  registry._hasPendingWrites = true;
  await registry.init('build_1', 'acc_1');
  assert.equal(registry.isOrphaned(), true);
  assert.ok(registry.records.has('pre-existing'), 'snapshot must survive orphaned init');
  assert.equal(flushSetCalls, 0, 'orphaned init must never flush');
  assert.deepEqual(warns, [], 'orphaned init must stay silent');
  console.warn = originalWarn;
  if (originalChrome === undefined) { delete globalThis.chrome; }
  else { globalThis.chrome = originalChrome; }
});

test('onOrphaned hook fires exactly once when context dies', async () => {
  ModelAdapter._validators.clear();
  const originalChrome = typeof chrome !== 'undefined' ? chrome : undefined;
  let lastError = null;
  const mockStorage = {
    get: (keys, cb) => cb({}),
    set: (_obj, cb) => {
      const e = lastError; lastError = null;
      if (e) { globalThis.chrome.runtime.lastError = e; }
      cb?.();
    },
    remove: (keys, cb) => cb?.()
  };
  globalThis.chrome = { runtime: { id: 'live-id' }, storage: { local: mockStorage } };
  const registry = new EvidenceRegistry(mockStorage);
  await registry.init();
  let hookCalls = 0;
  registry.onOrphaned(() => { hookCalls++; });
  lastError = { message: 'Extension context invalidated' };
  registry.recordGenerationEvidence('gemini-3.8-flash', {
    endpoint: 'StreamGenerate',
    buildLabel: 'boq_test',
    sessionEpoch: registry.currentSessionEpoch,
    responseVerified: true,
    requestSignature: { hasEnvelope: true, outerLength: 2, structure: [] }
  });
  // record*() fires saveToStorage() without awaiting it — wait for the
  // callback-driven orphan detection before asserting.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(hookCalls, 1);
  let lateCalls = 0;
  registry.onOrphaned(() => { lateCalls++; });
  assert.equal(lateCalls, 1, 'late registration after orphaning fires immediately');
  await registry.saveToStorage();
  assert.equal(hookCalls, 1, 'hook must not re-fire');
  if (originalChrome === undefined) { delete globalThis.chrome; }
  else { globalThis.chrome = originalChrome; }
});
