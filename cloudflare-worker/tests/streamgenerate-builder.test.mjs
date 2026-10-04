// ============================================================
// KAN-236: 20-Field Topological StreamGenerate Payload Builder
// & Multi-Notebook Token Contract Specification Suite
//
// REQUIREMENTS & GUARDRAILS SPECIFIED:
// 1. 20-Field Topological Invariant:
//    - Root request array MUST have exactly 20 elements (indices [0] through [19]).
//    - Replaces the legacy 12-field format from ProtocolDecoder.encodeRequest that Google rejects.
// 2. Index Field Invariants:
//    - [0]: `[prompt.trim(), 0, null, chipBranchOrNull, null, null, 0]`
//    - [1]: `[isThai ? "th" : "en"]`
//    - [2]: strictly `null` (resolving legacy type contradiction where builder sent state array)
//    - [3]: context block string (or null if absent)
//    - [4]: 32-character hex conversationId string (or null if new conversation)
//    - [5], [8], [9], [12], [13], [14], [15], [16]: strictly `null` (invariant null fields)
//    - [6]: number (default 0 or 1)
//    - [7]: number (default 0 or 1)
//    - [10]: numeric array (e.g. `[1]`)
//    - [11]: number (default 0)
//    - [17]: number (default 1)
//    - [18]: number (default 0)
// 3. Notebook Binding Modes:
//    - Mode A (Horo Token): When attached notebook is Horo (b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0)
//      or has an 88-char token, field [0][3] carries 88-char token (fp cff9779e), [19] is null.
//    - Mode B (Resource Reference): When attached notebook is referenced by UUID without 88-char token,
//      field [0][3] is null and field [19] is "notebooks/<uuid>" (46 characters).
//    - Mode C (Plain / Ungrounded): When no notebook is attached, both [0][3] and [19] are null.
// 4. G1 Zero-Leak Guardrail & Sanitation:
//    - Builder MUST never accept raw credentials, cookies, or SNlM0e in any field.
//    - Serialized payload wraps in Google RPC envelope: `JSON.stringify([null, JSON.stringify(reqArray)])`.
// 5. Integration with ProtocolDecoder:
//    - `buildStreamGeneratePayload(messages, state, model, options)` or
//      `ProtocolDecoder.encodeModernRequest(messages, state, model, options)` exports modern 20-field payload.
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerSrcPath = path.resolve(__dirname, '../src/index.js');
const builderSrcPath = path.resolve(__dirname, '../src/streamgenerate-builder.js');

import * as modelCatalog from '../src/model-catalog.js';
import * as emulator from '../src/tool-emulator.ts';
import * as pdfLib from 'pdf-lib';
import * as liveness from '../src/liveness.js';
import * as geminiRefusal from '../src/gemini-refusal.js';
import * as promptTemplates from '../src/prompt-templates.js';
import * as horoPrompts from "../src/horo-prompts.js";

const HORO_NOTEBOOK_ID = 'b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0';
const SAMPLE_88_TOKEN = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6A7b8C9d0E1f2G3h4I5j6K7l8M9n0O1p2Q3r4';
const SECOND_NOTEBOOK_UUID = '7a3c8e12-4d5f-4a6b-9c8e-1f2a3b4c5d6e';

// ─── Module & Builder Resolution ─────────────────────────────────────

function createVmContext() {
  const sandbox = {
    ...modelCatalog,
    ...emulator,
    ...pdfLib,
    ...liveness,
    ...geminiRefusal,
    ...promptTemplates,
  ...horoPrompts,
    DurableObject: class {},
    crypto,
    Request,
    Response,
    URL,
    TextEncoder,
    TextDecoder,
    TextEncoderStream: class {},
    TransformStream,
    ReadableStream,
    WebSocketPair: class {},
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => {},
  };
  sandbox.globalThis = sandbox;
  return sandbox;
}

function loadProtocolDecoder() {
  const source = fs.readFileSync(workerSrcPath, 'utf8');
  const sandbox = createVmContext();
  const res = vm.runInNewContext(
    source
      .replace(/import[\s\S]*?from "[^"\n]+";/g, '')
      .replaceAll('export class ', 'class ')
      .replace('export default {', 'const entry = {') +
      '\n;({ ProtocolDecoder: typeof ProtocolDecoder !== "undefined" ? ProtocolDecoder : null })',
    sandbox
  );
  return res.ProtocolDecoder;
}

async function resolveBuilder() {
  // 1. Try dedicated module file if created
  if (fs.existsSync(builderSrcPath)) {
    try {
      const mod = await import(builderSrcPath);
      if (typeof mod.buildStreamGeneratePayload === 'function') return mod.buildStreamGeneratePayload;
      if (typeof mod.encodeModernRequest === 'function') return mod.encodeModernRequest;
      if (typeof mod.default === 'function') return mod.default;
      if (typeof mod.default?.buildStreamGeneratePayload === 'function') {
        return mod.default.buildStreamGeneratePayload.bind(mod.default);
      }
      if (typeof mod.default?.encodeModernRequest === 'function') {
        return mod.default.encodeModernRequest.bind(mod.default);
      }
    } catch {
      // module load failure
    }
  }

  // 2. Try ProtocolDecoder methods or top-level export in src/index.js
  const source = fs.readFileSync(workerSrcPath, 'utf8');
  const sandbox = createVmContext();
  try {
    const res = vm.runInNewContext(
      source
        .replace(/import[\s\S]*?from "[^"\n]+";/g, '')
        .replaceAll('export class ', 'class ')
        .replace('export default {', 'const entry = {') +
        '\n;({ ' +
        'ProtocolDecoder: typeof ProtocolDecoder !== "undefined" ? ProtocolDecoder : null, ' +
        'buildStreamGeneratePayload: typeof buildStreamGeneratePayload !== "undefined" ? buildStreamGeneratePayload : null ' +
        '})',
      sandbox
    );

    if (typeof res.buildStreamGeneratePayload === 'function') {
      return res.buildStreamGeneratePayload;
    }
    if (typeof res.ProtocolDecoder?.encodeModernRequest === 'function') {
      return res.ProtocolDecoder.encodeModernRequest.bind(res.ProtocolDecoder);
    }
    if (typeof res.ProtocolDecoder?.buildStreamGeneratePayload === 'function') {
      return res.ProtocolDecoder.buildStreamGeneratePayload.bind(res.ProtocolDecoder);
    }
  } catch {
    // vm evaluation failure
  }

  return null;
}

function parseRpcPayload(rawOutput) {
  assert.equal(typeof rawOutput, 'string', 'builder must return a serialized JSON string');

  let envelope;
  try {
    envelope = JSON.parse(rawOutput);
  } catch (err) {
    assert.fail(`Payload envelope is not valid JSON: ${err.message}`);
  }

  // Google RPC envelope format: [null, JSON.stringify(reqArray)]
  assert.ok(Array.isArray(envelope), 'Google RPC envelope must be a JSON array');
  assert.equal(envelope.length, 2, 'Google RPC envelope must have exactly 2 elements [null, innerString]');
  assert.strictEqual(envelope[0], null, 'Google RPC envelope index [0] must be strictly null');
  assert.equal(typeof envelope[1], 'string', 'Google RPC envelope index [1] must be a JSON string');

  let reqArray;
  try {
    reqArray = JSON.parse(envelope[1]);
  } catch (err) {
    assert.fail(`Inner payload is not valid JSON: ${err.message}`);
  }

  assert.ok(Array.isArray(reqArray), 'Inner payload must be a JSON array (reqArray)');
  return { envelope, reqArray, raw: rawOutput };
}

// =====================================================================
// 1. 20-FIELD TOPOLOGICAL INVARIANT (Requirement 1 & 2)
// =====================================================================

test('invariant: legacy ProtocolDecoder.encodeRequest emits 12 fields while modern builder emits 20 fields', async () => {
  const ProtocolDecoder = loadProtocolDecoder();
  assert.ok(ProtocolDecoder, 'ProtocolDecoder must exist in src/index.js');

  const messages = [{ role: 'user', content: 'Explain quantum entanglement' }];
  const state = { conversationId: 'c_09b7b2e566914f6b896da347f3b890a1', responseId: 'r_1', choiceId: 'ch_1' };

  // 1. Legacy format verification: Google rejects 12-field format
  const legacyRaw = ProtocolDecoder.encodeRequest(messages, state, 'gemini-3.8-flash');
  const legacyParsed = JSON.parse(JSON.parse(legacyRaw)[1]);
  assert.equal(legacyParsed.length, 12, 'legacy encodeRequest emits 12 fields');

  // 2. Modern builder verification: MUST emit 20 fields
  const builder = await resolveBuilder();
  assert.ok(typeof builder === 'function', 'modern builder function must be exported and implemented');

  const modernRaw = builder(messages, state, 'gemini-3.8-flash', {});
  const { reqArray } = parseRpcPayload(modernRaw);
  assert.equal(reqArray.length, 20, 'modern builder root request array MUST have exactly 20 elements (indices [0]..[19])');
});

test('field [0]: structure matches [prompt.trim(), 0, null, chipBranchOrNull, null, null, 0]', async () => {
  const builder = await resolveBuilder();
  assert.ok(typeof builder === 'function', 'modern builder function must be exported and implemented');

  const rawPrompt = '   Summarize this research paper   \n\n';
  const messages = [{ role: 'user', content: rawPrompt }];
  const { reqArray } = parseRpcPayload(builder(messages, {}, 'gemini-3.8-flash', {}));

  const field0 = reqArray[0];
  assert.ok(Array.isArray(field0), 'field [0] must be an array');
  assert.equal(field0.length, 7, 'field [0] must have exactly 7 elements');

  assert.equal(field0[0], rawPrompt.trim(), '[0][0] must be trimmed prompt text');
  assert.strictEqual(field0[1], 0, '[0][1] must be number 0');
  assert.strictEqual(field0[2], null, '[0][2] must be strictly null');
  assert.strictEqual(field0[3], null, '[0][3] must be null when ungrounded');
  assert.strictEqual(field0[4], null, '[0][4] must be strictly null');
  assert.strictEqual(field0[5], null, '[0][5] must be strictly null');
  assert.strictEqual(field0[6], 0, '[0][6] must be number 0');
});

test('field [1]: locale array emits ["th"] for Thai text and ["en"] for non-Thai text', async () => {
  const builder = await resolveBuilder();
  assert.ok(typeof builder === 'function', 'modern builder function must be exported and implemented');

  // Case A: English text
  const enMessages = [{ role: 'user', content: 'Translate this text' }];
  const { reqArray: enReq } = parseRpcPayload(builder(enMessages, {}, 'gemini-3.8-flash', {}));
  assert.deepEqual(enReq[1], ['en'], 'English prompt must emit locale ["en"] at field [1]');

  // Case B: Thai text
  const thMessages = [{ role: 'user', content: 'สวัสดีครับ ขอสอบถามดวงชะตา' }];
  const { reqArray: thReq } = parseRpcPayload(builder(thMessages, {}, 'gemini-3.8-flash', {}));
  assert.deepEqual(thReq[1], ['th'], 'Thai prompt must emit locale ["th"] at field [1]');
});

test('field [2]: strictly null across all captures, resolving legacy type contradiction', async () => {
  const builder = await resolveBuilder();
  assert.ok(typeof builder === 'function', 'modern builder function must be exported and implemented');

  const messages = [{ role: 'user', content: 'Test prompt' }];
  const state = { conversationId: 'c_09b7b2e566914f6b896da347f3b890a1', responseId: 'r_test', choiceId: 'ch_test' };

  const { reqArray } = parseRpcPayload(builder(messages, state, 'gemini-3.8-flash', {}));

  // Browser wire captures demonstrate [2] is strictly null, NOT a 6-element state array
  assert.strictEqual(
    reqArray[2],
    null,
    'field [2] must be strictly null to match observed browser wire payloads and resolve type contradiction'
  );
});

test('field [3]: context block string when provided, strictly null when absent', async () => {
  const builder = await resolveBuilder();
  assert.ok(typeof builder === 'function', 'modern builder function must be exported and implemented');

  const messages = [{ role: 'user', content: 'Test prompt' }];

  // Case A: Absent context block
  const { reqArray: absentReq } = parseRpcPayload(builder(messages, {}, 'gemini-3.8-flash', {}));
  assert.strictEqual(absentReq[3], null, 'field [3] must be strictly null when context block is absent');

  // Case B: Present context block
  const contextStr = 'DYNAMIC_CONTEXT_BLOCK_DATA_SECTION_v1_ACTIVE_PARAMETERS';
  const { reqArray: presentReq } = parseRpcPayload(
    builder(messages, {}, 'gemini-3.8-flash', { contextBlock: contextStr })
  );
  assert.equal(presentReq[3], contextStr, 'field [3] must carry the dynamic context block string when provided');
});

test('field [4]: 32-character hex conversationId string, or null for new conversations', async () => {
  const builder = await resolveBuilder();
  assert.ok(typeof builder === 'function', 'modern builder function must be exported and implemented');

  const messages = [{ role: 'user', content: 'Hello' }];

  // Case A: New conversation (null)
  const { reqArray: newReq } = parseRpcPayload(builder(messages, {}, 'gemini-3.8-flash', {}));
  assert.strictEqual(newReq[4], null, 'field [4] must be null for new conversations');

  // Case B: Existing conversation with 32-hex ID
  const convId32 = '09b7b2e566914f6b896da347f3b890a1';
  const { reqArray: existReq } = parseRpcPayload(
    builder(messages, { conversationId: convId32 }, 'gemini-3.8-flash', {})
  );
  assert.equal(existReq[4], convId32, 'field [4] must carry the 32-hex conversationId string');
  assert.equal(existReq[4].length, 32, 'conversationId must be exactly 32 hex characters');
  assert.match(existReq[4], /^[0-9a-fA-F]{32}$/, 'conversationId must be valid hex characters');
});

test('invariant null fields: [5], [8], [9], [12], [13], [14], [15], [16] are strictly null', async () => {
  const builder = await resolveBuilder();
  assert.ok(typeof builder === 'function', 'modern builder function must be exported and implemented');

  const messages = [{ role: 'user', content: 'Check null invariants' }];
  const { reqArray } = parseRpcPayload(builder(messages, {}, 'gemini-3.8-flash', {}));

  const NULL_INDICES = [5, 8, 9, 12, 13, 14, 15, 16];
  for (const idx of NULL_INDICES) {
    assert.strictEqual(
      reqArray[idx],
      null,
      `Field [${idx}] must be strictly null across all captures and modes`
    );
  }
});

test('numeric invariant fields: [6], [7], [10], [11], [17], [18] have expected scalar/array values', async () => {
  const builder = await resolveBuilder();
  assert.ok(typeof builder === 'function', 'modern builder function must be exported and implemented');

  const messages = [{ role: 'user', content: 'Check numeric invariants' }];
  const { reqArray } = parseRpcPayload(builder(messages, {}, 'gemini-3.8-flash', {}));

  // [6]: number (observed: 0 or 1, or numeric array [1] / [0])
  assert.ok(
    typeof reqArray[6] === 'number' || (Array.isArray(reqArray[6]) && typeof reqArray[6][0] === 'number'),
    'field [6] must be a number or numeric array'
  );

  // [7]: number (default 0 or 1)
  assert.ok(typeof reqArray[7] === 'number', 'field [7] must be a number');

  // [10]: numeric array (e.g. [1])
  assert.ok(Array.isArray(reqArray[10]), 'field [10] must be an array');
  assert.ok(typeof reqArray[10][0] === 'number', 'field [10][0] must be a number');

  // [11]: number (default 0)
  assert.strictEqual(reqArray[11], 0, 'field [11] must be number 0');

  // [17]: number (default 1) or array
  assert.ok(
    typeof reqArray[17] === 'number' || Array.isArray(reqArray[17]),
    'field [17] must be number (default 1) or nested array'
  );

  // [18]: number (default 0)
  assert.strictEqual(reqArray[18], 0, 'field [18] must be number 0');
});

// =====================================================================
// 2. NOTEBOOK BINDING MODES (Requirement 3)
// =====================================================================

test('Mode A (Horo Token): binds Horo notebook via 88-char token at [0][3] and leaves [19] strictly null', async () => {
  const builder = await resolveBuilder();
  assert.ok(typeof builder === 'function', 'modern builder function must be exported and implemented');

  const messages = [{ role: 'user', content: 'ทำนายดวงชะตาตามหลักปาจื่อ' }];

  // Call with Horo notebook ID and/or 88-char token
  const options = {
    notebookId: HORO_NOTEBOOK_ID,
    notebookToken: SAMPLE_88_TOKEN,
  };

  const { reqArray } = parseRpcPayload(builder(messages, {}, 'gemini-3.8-flash', options));

  // Field [0][3] must carry the nested chip array
  const chipBranch = reqArray[0][3];
  assert.ok(Array.isArray(chipBranch), 'Mode A: [0][3] must be an array');
  assert.ok(Array.isArray(chipBranch[0]), 'Mode A: [0][3][0] must be an array');

  // The 88-char token lives at [0][3][0][2]
  const token = chipBranch[0][2];
  assert.equal(typeof token, 'string', 'Mode A: token at [0][3][0][2] must be a string');
  assert.equal(token.length, 88, 'Mode A: token length must be exactly 88 characters');
  assert.equal(token, SAMPLE_88_TOKEN, 'Mode A: token must match the supplied 88-char Horo token');

  // Field [19] must be strictly null in Mode A
  assert.strictEqual(
    reqArray[19],
    null,
    'Mode A: field [19] must be strictly null when notebook is attached via [0][3] chip token'
  );
});

test('Mode A (Horo Token Default): automatically populates known 88-char token when Horo UUID is specified without token', async () => {
  const builder = await resolveBuilder();
  assert.ok(typeof builder === 'function', 'modern builder function must be exported and implemented');

  const messages = [{ role: 'user', content: 'คำนวณดวง' }];

  // Specify Horo notebook UUID without providing explicit token
  const options = { notebookId: HORO_NOTEBOOK_ID };
  const { reqArray } = parseRpcPayload(builder(messages, {}, 'gemini-3.8-flash', options));

  const chipBranch = reqArray[0][3];
  assert.ok(Array.isArray(chipBranch), 'Mode A default: [0][3] must be populated for Horo notebook ID');

  const token = chipBranch[0][2];
  assert.equal(typeof token, 'string', 'Mode A default: token must be a string');
  assert.equal(token.length, 88, 'Mode A default: token must be 88 characters long');
  assert.match(token, /^[a-zA-Z0-9]{88}$/, 'Mode A default: token must consist of alphanumeric chars');

  assert.strictEqual(reqArray[19], null, 'Mode A default: [19] must be null');
});

test('Mode B (Resource Reference): binds non-token notebook via "notebooks/<uuid>" at [19] and leaves [0][3] null', async () => {
  const builder = await resolveBuilder();
  assert.ok(typeof builder === 'function', 'modern builder function must be exported and implemented');

  const messages = [{ role: 'user', content: 'What are the Claude Code architectural guidelines?' }];

  // Pass a secondary notebook UUID without an 88-char token
  const options = { notebookId: SECOND_NOTEBOOK_UUID };
  const { reqArray } = parseRpcPayload(builder(messages, {}, 'gemini-3.8-flash', options));

  // Field [0][3] must be null
  assert.strictEqual(
    reqArray[0][3],
    null,
    'Mode B: field [0][3] must be strictly null when notebook is bound via resource reference'
  );

  // Field [19] must be "notebooks/<uuid>" (10 chars prefix + 36 chars UUID = 46 chars)
  assert.equal(typeof reqArray[19], 'string', 'Mode B: field [19] must be a string');
  assert.equal(reqArray[19].length, 46, 'Mode B: field [19] must be exactly 46 characters long (notebooks/<uuid>)');
  assert.equal(
    reqArray[19],
    `notebooks/${SECOND_NOTEBOOK_UUID}`,
    'Mode B: field [19] must follow the "notebooks/<uuid>" resource scheme format'
  );
});

test('Mode C (Plain / Ungrounded): leaves both [0][3] and [19] strictly null when ungrounded', async () => {
  const builder = await resolveBuilder();
  assert.ok(typeof builder === 'function', 'modern builder function must be exported and implemented');

  const messages = [{ role: 'user', content: 'Tell me a joke' }];
  const { reqArray } = parseRpcPayload(builder(messages, {}, 'gemini-3.8-flash', {}));

  // In ungrounded / plain mode, both notebook attachment slots MUST be null
  assert.strictEqual(reqArray[0][3], null, 'Mode C: [0][3] must be null when ungrounded');
  assert.strictEqual(reqArray[19], null, 'Mode C: [19] must be null when ungrounded');
});

// =====================================================================
// 3. G1 ZERO-LEAK GUARDRAIL & ADVERSARIAL SANITATION (Requirement 4)
// =====================================================================

test('G1 guardrail: payload wraps strictly in Google RPC envelope format [null, JSON.stringify(reqArray)]', async () => {
  const builder = await resolveBuilder();
  assert.ok(typeof builder === 'function', 'modern builder function must be exported and implemented');

  const messages = [{ role: 'user', content: 'Test envelope format' }];
  const rawOutput = builder(messages, {}, 'gemini-3.8-flash', {});

  const { envelope } = parseRpcPayload(rawOutput);
  assert.equal(envelope[0], null, 'Google RPC envelope slot [0] must strictly be null');
  assert.equal(typeof envelope[1], 'string', 'Google RPC envelope slot [1] must be a string of JSON');

  // Verify envelope starts with expected JSON array syntax
  assert.ok(rawOutput.startsWith('[null,"'), 'envelope serialization must match [null,"...');
});

test('G1 adversarial: builder NEVER accepts or leaks raw credentials, cookies, or SNlM0e in any field', async () => {
  const builder = await resolveBuilder();
  assert.ok(typeof builder === 'function', 'modern builder function must be exported and implemented');

  const ADVERSARIAL_SECRETS = [
    'SNlM0e=AIzaSyD_LEAK_TEST_TOKEN_XYZ_9999',
    'HSID=adversarial_hsid_cookie_value_123',
    'Bearer super-secret-bearer-token-456',
    'CLIENT_API_KEY_SECRET_789',
    'BRIDGE_AUTH_TOKEN_SECRET_987',
  ];

  // Attempt to inject credentials and session cookies via state and options
  const messages = [{ role: 'user', content: 'Adversarial leak test' }];
  const adversarialState = {
    conversationId: '09b7b2e566914f6b896da347f3b890a1',
    tokens: 'SNlM0e=AIzaSyD_LEAK_TEST_TOKEN_XYZ_9999',
    cookie: 'HSID=adversarial_hsid_cookie_value_123',
    authorization: 'Bearer super-secret-bearer-token-456',
  };
  const adversarialOptions = {
    apiKey: 'CLIENT_API_KEY_SECRET_789',
    bridgeToken: 'BRIDGE_AUTH_TOKEN_SECRET_987',
    rawCookie: 'SNlM0e=AIzaSyD_LEAK_TEST_TOKEN_XYZ_9999',
  };

  const rawOutput = builder(messages, adversarialState, 'gemini-3.8-flash', adversarialOptions);
  const { reqArray } = parseRpcPayload(rawOutput);

  // Adversarial assertion scan across raw output string
  for (const secret of ADVERSARIAL_SECRETS) {
    assert.ok(
      !rawOutput.includes(secret),
      `G1 Leak Violation: Serialized payload contains raw secret "${secret}"`
    );
  }

  // Scan all individual array nodes
  const serializedReq = JSON.stringify(reqArray);
  for (const secret of ADVERSARIAL_SECRETS) {
    assert.ok(
      !serializedReq.includes(secret),
      `G1 Leak Violation: reqArray contains secret "${secret}"`
    );
  }
});

// =====================================================================
// 4. INTEGRATION WITH PROTOCOLDECODER (Requirement 5)
// =====================================================================

test('integration: exports buildStreamGeneratePayload and ProtocolDecoder.encodeModernRequest interfaces', async () => {
  const ProtocolDecoder = loadProtocolDecoder();
  const builder = await resolveBuilder();

  assert.ok(typeof builder === 'function', 'buildStreamGeneratePayload or encodeModernRequest must be callable');

  const messages = [{ role: 'user', content: 'Integration test prompt' }];
  const state = { conversationId: '09b7b2e566914f6b896da347f3b890a1' };

  // Call the resolved builder
  const payload1 = builder(messages, state, 'gemini-3.8-flash', { notebookId: HORO_NOTEBOOK_ID });
  const { reqArray: req1 } = parseRpcPayload(payload1);
  assert.equal(req1.length, 20, 'builder must return 20-field payload');

  // If ProtocolDecoder has encodeModernRequest, verify it produces identical valid 20-field payload
  if (typeof ProtocolDecoder.encodeModernRequest === 'function') {
    const payload2 = ProtocolDecoder.encodeModernRequest(messages, state, 'gemini-3.8-flash', {
      notebookId: HORO_NOTEBOOK_ID,
    });
    const { reqArray: req2 } = parseRpcPayload(payload2);
    assert.equal(req2.length, 20, 'ProtocolDecoder.encodeModernRequest must return 20-field payload');
    assert.deepEqual(req1, req2, 'both export methods must produce identical 20-field payload');
  }
});
