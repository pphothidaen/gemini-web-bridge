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
