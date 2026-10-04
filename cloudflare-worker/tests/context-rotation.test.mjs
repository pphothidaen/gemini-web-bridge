// ============================================================
// KAN-242: Automatic Conversation Context Rotation
// Test-Driven Development (TDD) Specification & Guardrail Suite
//
// Baseline: v4.7.34. Date: 2026-10-04.
// Reference: docs/verification/kan242-context-rotation-design.md
//
// Defines requirements and guardrails BEFORE implementation:
// 1. Threshold Behavior (unset/0/NaN, responses < threshold, responses >= threshold)
// 2. Guardrails (pinned scopes, in-flight protection, probe timeout & fallback, G1 zero-leak telemetry)
// 3. horo_consult Integration (wire order invariant: rotation strictly BEFORE attach)
// 4. State & Health Introspection (rotationState, /health exposition)
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import * as modelCatalog from '../src/model-catalog.js';
import * as emulator from '../src/tool-emulator.ts';
import * as pdfLib from 'pdf-lib';
import * as liveness from '../src/liveness.js';
import * as geminiRefusal from '../src/gemini-refusal.js';
import * as promptTemplates from '../src/prompt-templates.js';
import { makeCtx } from './helpers/fake-ctx.mjs';

// ─── DO Sandbox Loader ────────────────────────────────────────

const doSource = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const doClassSrc = doSource
  .replace(/import[\s\S]*?from "[^"]+";/g, '')
  .replaceAll('export class ', 'class ')
  .replace('export default {', 'const entry = {');

const workerdCrypto = {
  randomUUID,
  getRandomValues: (arr) => globalThis.crypto.getRandomValues(arr),
  subtle: globalThis.crypto.subtle,
};

class MockResponse {
  constructor(body = null, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = init.headers || {};
    this.ok = this.status >= 200 && this.status < 300;
  }
  async text() { return this.body == null ? '' : String(this.body); }
  async json() { return JSON.parse(await this.text()); }
}

function loadDO() {
  const context = {
    ...modelCatalog,
    ...emulator,
    ...pdfLib,
    ...liveness,
    ...geminiRefusal,
    ...promptTemplates,
    DurableObject: class {},
    crypto: workerdCrypto,
    Response: MockResponse,
    Request,
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
  return vm.runInNewContext(doClassSrc + '\n;({GeminiBridgeDO})', context).GeminiBridgeDO;
}

const GeminiBridgeDO = loadDO();

// ─── Test Harness Helpers ─────────────────────────────────────

function createTestBridge(envOverrides = {}) {
  const env = {
    CLIENT_API_KEY: 'secret-token-123',
    BRIDGE_AUTH_TOKEN: 'bridge-secret',
    ...envOverrides,
  };
  const b = new GeminiBridgeDO(makeCtx(), env);
  b.waitForExtension = async () => {};
  b.currentTokens = { sessionReady: true };
  b.currentScope = 'app';
  b.replaceModelCatalog({
    protocolVersion: 2,
    models: [{
      id: 'gemini-3.8-flash',
      name: '3.8 Flash',
      thinking: true,
      verification: 'verified',
      mapping_revision: 'rev-1',
    }],
  });
  return b;
}

function attachMockSocket(b, onSend = null) {
  const sent = [];
  b.activeSocket = {
    readyState: 1,
    send: (raw) => {
      const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      sent.push(msg);
      if (onSend) {
        queueMicrotask(() => onSend(msg, b, sent));
      }
    },
  };
  return sent;
}

function deliver(b, msg) {
  if (msg.type === 'SCOPE_READY' && msg.scope) {
    b.currentScope = msg.scope;
  }
  if (msg.requestId && b.activeStreams.has(msg.requestId)) {
    b.activeStreams.get(msg.requestId)(msg);
  }
}

function createAutoResponder({
  responses = 0,
  generating = false,
  failScopeSwitch = false,
  scope = 'app:c_mock',
  skipStats = false,
} = {}) {
  return (msg, b) => {
    if (msg.type === 'CONVERSATION_STATS') {
      if (skipStats) return;
      deliver(b, {
        type: 'CONVERSATION_STATS_RESULT',
        requestId: msg.requestId,
        responses,
        userQueries: 1,
        scope,
        pathname: `/${scope.replace(':', '/')}`,
        generating,
      });
      return;
    }
    if (msg.type === 'PREPARE_SCOPE') {
      if (failScopeSwitch) {
        deliver(b, {
          type: 'STREAM_ERROR',
          requestId: msg.requestId,
          error: 'Scope switch failed',
          code: 'scope_switch_failed',
        });
      } else {
        deliver(b, {
          type: 'SCOPE_READY',
          requestId: msg.requestId,
          scope: msg.scope,
        });
      }
      return;
    }
    if (msg.type === 'ATTACH_NOTEBOOK') {
      deliver(b, {
        type: 'NOTEBOOK_ATTACH_RESULT',
        requestId: msg.requestId,
        ok: true,
        attached: [msg.notebookName],
      });
      return;
    }
    if (msg.type === 'TYPE_PROMPT') {
      deliver(b, {
        type: 'TYPE_PROMPT_RESULT',
        requestId: msg.requestId,
        ok: true,
        responsesBefore: responses,
      });
      return;
    }
    if (msg.type === 'COLLECT_ANSWER') {
      deliver(b, {
        type: 'COLLECT_ANSWER_RESULT',
        requestId: msg.requestId,
        ok: true,
        text: 'Astrological reading response from model',
        responses: 1,
      });
      return;
    }
    if (msg.type === 'VERIFY_GROUNDING') {
      deliver(b, {
        type: 'GROUNDING_RESULT',
        requestId: msg.requestId,
        ok: true,
        verified: true,
        chipCount: 1,
        citeMarkers: 1,
        sources: ['HoroConsultant'],
      });
      return;
    }
  };
}

const postMcp = (b, body) => b.fetch(new Request('https://test/mcp', {
  method: 'POST',
  headers: { Authorization: 'Bearer secret-token-123', 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}));

const callTool = async (b, id, name, args) => {
  const res = await postMcp(b, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  return res.json();
};

// ═════════════════════════════════════════════════════════════
// 1. Threshold Behavior
// ═════════════════════════════════════════════════════════════

test('1.1 Threshold: rotation is disabled when CONTEXT_ROTATION_THRESHOLD is unset', async () => {
  const b = createTestBridge({}); // No CONTEXT_ROTATION_THRESHOLD
  const sent = attachMockSocket(b);

  assert.equal(typeof b.rotationThreshold, 'function', 'rotationThreshold() method must exist on DO');
  assert.ok(b.rotationThreshold() <= 0, 'rotationThreshold() must return <= 0 when env var is unset');

  assert.equal(typeof b.ensureConversationHeadroom, 'function', 'ensureConversationHeadroom() method must exist on DO');
  const result = await b.ensureConversationHeadroom({ requestId: 'req_unset' });

  assert.equal(result.rotated, false, 'must not rotate when threshold is unset');
  assert.equal(result.reason, 'disabled', 'reason must be disabled');
  assert.equal(sent.length, 0, 'no wire messages (CONVERSATION_STATS or PREPARE_SCOPE) should be sent when disabled');
});

test('1.2 Threshold: rotation is disabled when CONTEXT_ROTATION_THRESHOLD is 0, NaN, or negative', async () => {
  for (const invalidVal of ['0', 'NaN', '-1', 'notanumber']) {
    const b = createTestBridge({ CONTEXT_ROTATION_THRESHOLD: invalidVal });
    const sent = attachMockSocket(b);

    assert.ok(b.rotationThreshold() <= 0, `rotationThreshold() must be <= 0 for value '${invalidVal}'`);
    const result = await b.ensureConversationHeadroom({ requestId: `req_invalid_${invalidVal}` });
    assert.equal(result.rotated, false);
    assert.equal(result.reason, 'disabled');
    assert.equal(sent.length, 0, 'no wire messages should be sent when disabled');
  }
});

test('1.3 Threshold: responses < threshold (7 < 8) triggers NO rotation', async () => {
  const b = createTestBridge({ CONTEXT_ROTATION_THRESHOLD: '8' });
  const sent = attachMockSocket(b, createAutoResponder({ responses: 7, generating: false }));

  b.lastCollectedResponseCount = 7;
  const result = await b.ensureConversationHeadroom({ requestId: 'req_below' });

  assert.equal(result.rotated, false, 'must not rotate when response count is below threshold');
  assert.equal(
    sent.some((m) => m.type === 'PREPARE_SCOPE'),
    false,
    'PREPARE_SCOPE must NOT be sent when count < threshold'
  );
  assert.equal(b.lastCollectedResponseCount, 7, 'response count must NOT be reset when no rotation occurs');
});

test('1.4 Threshold: responses >= threshold (8 >= 8) triggers prepareScope("app") and resets count', async () => {
  const b = createTestBridge({ CONTEXT_ROTATION_THRESHOLD: '8' });
  const sent = attachMockSocket(b, createAutoResponder({ responses: 8, generating: false }));

  b.lastCollectedResponseCount = 8;
  const result = await b.ensureConversationHeadroom({ requestId: 'req_at_threshold' });

  assert.equal(result.rotated, true, 'must rotate when count >= threshold');

  // Verify PREPARE_SCOPE was sent down the wire with bare "app" scope
  const prepare = sent.find((m) => m.type === 'PREPARE_SCOPE');
  assert.ok(prepare, 'PREPARE_SCOPE must be emitted to trigger fresh conversation');
  assert.equal(prepare.scope, 'app', 'PREPARE_SCOPE must target bare "app" to open fresh chat');

  // Verify state reset post-rotation
  assert.equal(b.currentScope, 'app', 'currentScope must be set to "app"');
  assert.equal(b.lastCollectedResponseCount, 0, 'lastCollectedResponseCount must be reset to 0');
  assert.ok(b.rotationState.total >= 1, 'rotation counter must increment');
});

test('1.5 Threshold: rotates at observed failure frontier (responses = 10, threshold = 8)', async () => {
  const b = createTestBridge({ CONTEXT_ROTATION_THRESHOLD: '8' });
  const sent = attachMockSocket(b, createAutoResponder({ responses: 10, generating: false }));

  const result = await b.ensureConversationHeadroom({ requestId: 'req_frontier_10' });

  assert.equal(result.rotated, true, 'must rotate when responses reached 10');
  assert.ok(sent.some((m) => m.type === 'PREPARE_SCOPE'), 'PREPARE_SCOPE must be emitted at frontier');
  assert.equal(b.lastCollectedResponseCount, 0, 'response count reset to 0');
});

test('1.6 Threshold: DOM probe count takes precedence over stale lastCollectedResponseCount (cold DO restart)', async () => {
  const b = createTestBridge({ CONTEXT_ROTATION_THRESHOLD: '8' });
  // Cold DO restart: in-memory count is 0, but the DOM holds 9 responses
  b.lastCollectedResponseCount = 0;
  const sent = attachMockSocket(b, createAutoResponder({ responses: 9, generating: false }));

  const result = await b.ensureConversationHeadroom({ requestId: 'req_cold_restart' });

  assert.equal(result.rotated, true, 'DOM probe must supersede stale in-memory count of 0');
  assert.ok(sent.some((m) => m.type === 'PREPARE_SCOPE'), 'must trigger rotation based on DOM truth');
});

test('1.7 Threshold: rotation forces prepareScope("app") even when currentScope is stale "app" (guards F5)', async () => {
  const b = createTestBridge({ CONTEXT_ROTATION_THRESHOLD: '8' });
  // F5 defect: DO currentScope is "app", but tab URL is /app/<id> with 8 responses
  b.currentScope = 'app';
  const sent = attachMockSocket(b, createAutoResponder({ responses: 8, generating: false }));

  const result = await b.ensureConversationHeadroom({ requestId: 'req_stale_app_scope' });

  assert.equal(result.rotated, true);
  const prepare = sent.find((m) => m.type === 'PREPARE_SCOPE');
  assert.ok(prepare, 'must NOT short-circuit like applyScope; prepareScope("app") must be explicitly dispatched');
  assert.equal(prepare.scope, 'app');
});

// ═════════════════════════════════════════════════════════════
// 2. Guardrails (G1-G5 & Adversarial Protections)
// ═════════════════════════════════════════════════════════════

test('2.1 Guardrail (Pinned Scope): explicit app:<id> scope is NEVER rotated', async () => {
  const b = createTestBridge({ CONTEXT_ROTATION_THRESHOLD: '8' });
  const sent = attachMockSocket(b, createAutoResponder({ responses: 10, generating: false }));

  // Caller explicitly asked for a specific conversation ID
  const result = await b.ensureConversationHeadroom({
    requestId: 'req_pinned_app',
    explicitScope: 'app:c_pinned_user_conversation_999',
  });

  assert.equal(result.rotated, false, 'pinned scope must never be rotated away');
  assert.equal(result.reason, 'pinned_scope', 'reason must be pinned_scope');
  assert.equal(
    sent.some((m) => m.type === 'PREPARE_SCOPE'),
    false,
    'PREPARE_SCOPE must NEVER be sent when scope is pinned'
  );
});

test('2.2 Guardrail (Pinned Scope): explicit notebook:<id> scope is NEVER rotated', async () => {
  const b = createTestBridge({ CONTEXT_ROTATION_THRESHOLD: '8' });
  const sent = attachMockSocket(b, createAutoResponder({ responses: 10, generating: false }));

  const result = await b.ensureConversationHeadroom({
    requestId: 'req_pinned_nb',
    explicitScope: 'notebook:b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0',
  });

  assert.equal(result.rotated, false, 'pinned notebook scope must never be rotated');
  assert.equal(result.reason, 'pinned_scope');
  assert.equal(
    sent.some((m) => m.type === 'PREPARE_SCOPE'),
    false,
    'PREPARE_SCOPE must NEVER be sent for explicit notebook scope'
  );
});

test('2.3 Guardrail (In-Flight Protection): does NOT rotate when tab reports generating: true', async () => {
  const b = createTestBridge({ CONTEXT_ROTATION_THRESHOLD: '8' });
  // Tab is actively streaming / generating an answer
  const sent = attachMockSocket(b, createAutoResponder({ responses: 10, generating: true }));

  const result = await b.ensureConversationHeadroom({ requestId: 'req_active_generation' });

  assert.equal(result.rotated, false, 'must not rotate while tab is actively generating');
  assert.equal(result.reason, 'generating');
  assert.equal(
    sent.some((m) => m.type === 'PREPARE_SCOPE'),
    false,
    'PREPARE_SCOPE must NOT be sent while generating'
  );
});

test('2.4 Guardrail (In-Flight Protection): does NOT rotate when typed turns are in-flight (typedTurnsInFlight > 0)', async () => {
  const b = createTestBridge({ CONTEXT_ROTATION_THRESHOLD: '8' });
  const sent = attachMockSocket(b, createAutoResponder({ responses: 10, generating: false }));

  // Simulate a concurrent typed turn already active in the tab
  b.typedTurnsInFlight = 1;

  const result = await b.ensureConversationHeadroom({ requestId: 'req_concurrent_typed_turn' });

  assert.equal(result.rotated, false, 'must not rotate when typedTurnsInFlight > 0');
  assert.equal(result.reason, 'in_flight');
  assert.equal(
    sent.some((m) => m.type === 'PREPARE_SCOPE'),
    false,
    'must not navigate the tab out from under a concurrent generation'
  );
});

test('2.5 Guardrail (In-Flight Protection): does NOT rotate when rotationState.inFlight is true', async () => {
  const b = createTestBridge({ CONTEXT_ROTATION_THRESHOLD: '8' });
  const sent = attachMockSocket(b, createAutoResponder({ responses: 10, generating: false }));

  // Simulate rotation already in progress
  if (!b.rotationState) b.rotationState = {};
  b.rotationState.inFlight = true;

  const result = await b.ensureConversationHeadroom({ requestId: 'req_rotation_in_flight' });

  assert.equal(result.rotated, false, 'must not start parallel rotation');
  assert.equal(result.reason, 'in_flight');
  assert.equal(
    sent.some((m) => m.type === 'PREPARE_SCOPE'),
    false
  );
});

test('2.6 Guardrail (Fallback): probe timeout falls back to lastCollectedResponseCount', async () => {
  const b = createTestBridge({ CONTEXT_ROTATION_THRESHOLD: '8' });
  // Older extension or unresponsive probe (skipStats: true)
  const sent = attachMockSocket(b, createAutoResponder({ responses: 0, skipStats: true }));

  // DO has steady-state piggybacked count of 9 responses
  b.lastCollectedResponseCount = 9;

  // Set small probe timeout to keep test fast (50ms)
  const result = await b.ensureConversationHeadroom({ requestId: 'req_probe_timeout', timeoutMs: 50 });

  assert.equal(result.rotated, true, 'must fall back to lastCollectedResponseCount and rotate');
  assert.ok(sent.some((m) => m.type === 'PREPARE_SCOPE'), 'PREPARE_SCOPE must be emitted via fallback count');
  assert.equal(b.lastCollectedResponseCount, 0);
});

test('2.7 Guardrail (Fail-Open): fails open when both probe and lastCollectedResponseCount are unavailable', async () => {
  const b = createTestBridge({ CONTEXT_ROTATION_THRESHOLD: '8' });
  const sent = attachMockSocket(b, createAutoResponder({ responses: 0, skipStats: true }));

  // Neither probe nor lastCollectedResponseCount is known
  b.lastCollectedResponseCount = 0;

  // Must NOT throw
  const result = await b.ensureConversationHeadroom({ requestId: 'req_probe_and_count_unknown', timeoutMs: 50 });

  assert.equal(result.rotated, false, 'fails open without rotation');
  assert.equal(result.reason, 'probe_unavailable', 'reason marks probe unavailable');
  assert.equal(
    sent.some((m) => m.type === 'PREPARE_SCOPE'),
    false
  );
});

test('2.8 Guardrail (Fail-Open): prepareScope error never throws, allows turn to proceed', async () => {
  const b = createTestBridge({ CONTEXT_ROTATION_THRESHOLD: '8' });
  // Scope switch fails (e.g. navigation timeout or extension error)
  attachMockSocket(b, createAutoResponder({ responses: 8, failScopeSwitch: true }));

  // Must NOT throw — rotation failure policy is fail-open
  const result = await b.ensureConversationHeadroom({ requestId: 'req_scope_switch_failure' });

  assert.equal(result.rotated, false, 'returns rotated: false when scope switch fails');
  assert.ok(result.error, 'error is captured and reported in result');
});

test('2.9 Guardrail (G1 Zero-Leak): rotation telemetry contains ONLY metadata, never prompt or response content', async () => {
  const b = createTestBridge({ CONTEXT_ROTATION_THRESHOLD: '8' });
  attachMockSocket(b, createAutoResponder({ responses: 8, generating: false }));

  await b.ensureConversationHeadroom({ requestId: 'req_g1_telemetry' });

  // Telemetry buffer must contain a rotation entry
  const entry = b.telemetryBuffer?.find((t) => t.kind === 'rotation');
  assert.ok(entry, 'telemetryBuffer must record entry with kind: "rotation"');

  // Verify allowed metadata fields
  assert.equal(entry.outcome, 'ok');
  assert.equal(typeof entry.durationMs, 'number');
  assert.equal(entry.responsesBefore, 8);
  assert.equal(entry.threshold, 8);

  // Invariant G-1: Strict ban on prompt / token / text content
  assert.equal(entry.prompt, undefined, 'telemetry must NOT leak prompt');
  assert.equal(entry.messages, undefined, 'telemetry must NOT leak messages');
  assert.equal(entry.response, undefined, 'telemetry must NOT leak response');
  assert.equal(entry.content, undefined, 'telemetry must NOT leak content');
  assert.equal(entry.text, undefined, 'telemetry must NOT leak text');

  const serialized = JSON.stringify(entry);
  assert.equal(serialized.includes('prompt'), false);
  assert.equal(serialized.includes('content'), false);
});

// ═════════════════════════════════════════════════════════════
// 3. horo_consult Integration & Wire Order Invariants
// ═════════════════════════════════════════════════════════════

test('3.1 Wire Invariant: horo_consult rotates BEFORE ATTACH_NOTEBOOK when responses >= threshold', async () => {
  const b = createTestBridge({ CONTEXT_ROTATION_THRESHOLD: '8' });
  const sent = attachMockSocket(b, createAutoResponder({ responses: 8, generating: false }));

  // Call horo_consult via standard MCP tools/call
  const res = await callTool(b, 'mcp_horo_1', 'horo_consult', {
    query: 'อาชีพที่เหมาะกับดวงชะตานี้คืออะไร',
  });

  assert.ok(res.result, 'horo_consult turn must succeed: ' + JSON.stringify(res.error || res));

  // Inspect the sequence of message types sent to the extension
  const sentTypes = sent.map((m) => m.type);

  const statsIdx = sentTypes.indexOf('CONVERSATION_STATS');
  const prepareIdx = sentTypes.indexOf('PREPARE_SCOPE');
  const attachIdx = sentTypes.indexOf('ATTACH_NOTEBOOK');
  const typePromptIdx = sentTypes.indexOf('TYPE_PROMPT');
  const collectIdx = sentTypes.indexOf('COLLECT_ANSWER');
  const verifyIdx = sentTypes.indexOf('VERIFY_GROUNDING');

  // Assert wire messages were sent
  assert.ok(statsIdx !== -1, 'CONVERSATION_STATS probe must be sent before turn');
  assert.ok(prepareIdx !== -1, 'PREPARE_SCOPE must be sent when responses >= threshold');
  assert.ok(attachIdx !== -1, 'ATTACH_NOTEBOOK must be sent');
  assert.ok(typePromptIdx !== -1, 'TYPE_PROMPT must be sent');
  assert.ok(collectIdx !== -1, 'COLLECT_ANSWER must be sent');
  assert.ok(verifyIdx !== -1, 'VERIFY_GROUNDING must be sent');

  // CRITICAL INVARIANT: PREPARE_SCOPE strictly BEFORE ATTACH_NOTEBOOK
  assert.ok(
    prepareIdx < attachIdx,
    `Wire order invariant violated: PREPARE_SCOPE (index ${prepareIdx}) must be sent BEFORE ATTACH_NOTEBOOK (index ${attachIdx}) so attached notebook chip is never destroyed by tab navigation`
  );

  // Full chronological pipeline validation
  assert.ok(statsIdx < prepareIdx, 'probe before prepare');
  assert.ok(attachIdx < typePromptIdx, 'attach before prompt typing');
  assert.ok(typePromptIdx < collectIdx, 'prompt typing before answer collection');
  assert.ok(collectIdx < verifyIdx, 'answer collection before grounding verification');
});

test('3.2 Wire Invariant: horo_consult with explicit pinned scope skips rotation and attaches notebook', async () => {
  const b = createTestBridge({ CONTEXT_ROTATION_THRESHOLD: '8' });
  const pinnedScope = 'app:c_pinned_specific_conversation';
  b.currentScope = pinnedScope;
  const sent = attachMockSocket(b, createAutoResponder({ responses: 10, generating: false, scope: pinnedScope }));

  const res = await callTool(b, 'mcp_horo_pinned', 'horo_consult', {
    query: 'คำถามดวงชะตาในห้องสนทนาเฉพาะ',
    scope: pinnedScope,
  });

  // PREPARE_SCOPE to "app" (which represents rotation / wiping context) must NEVER be sent
  const rotationsToApp = sent.filter((m) => m.type === 'PREPARE_SCOPE' && m.scope === 'app');
  assert.equal(
    rotationsToApp.length,
    0,
    'PREPARE_SCOPE to "app" (rotation) must NEVER be sent when caller explicitly pinned the scope'
  );

  // Invariant: Headroom check must record skipped telemetry for pinned scope
  const skippedTel = b.telemetryBuffer?.find((t) => t.kind === 'rotation' && t.skipped === 'pinned_scope');
  assert.ok(
    skippedTel,
    'rotation telemetry must record skipped: "pinned_scope" for explicit pinned scope on horo_consult'
  );

  assert.ok(
    sent.some((m) => m.type === 'ATTACH_NOTEBOOK'),
    'ATTACH_NOTEBOOK must still run for pinned scope'
  );
});

test('3.3 Wire Invariant: horo_consult below threshold attaches notebook without rotating', async () => {
  const b = createTestBridge({ CONTEXT_ROTATION_THRESHOLD: '8' });
  const sent = attachMockSocket(b, createAutoResponder({ responses: 3, generating: false }));

  const res = await callTool(b, 'mcp_horo_below', 'horo_consult', {
    query: 'คำถามดวงชะตาบทใหม่',
  });

  const sentTypes = sent.map((m) => m.type);
  assert.ok(sentTypes.includes('CONVERSATION_STATS'), 'probe must still run');
  assert.equal(sentTypes.includes('PREPARE_SCOPE'), false, 'must not rotate when responses < threshold');
  assert.ok(sentTypes.includes('ATTACH_NOTEBOOK'), 'must attach notebook directly');
});

// ═════════════════════════════════════════════════════════════
// 4. State & Health Introspection
// ═════════════════════════════════════════════════════════════

test('4.1 DO constructor initializes rotationState and typedTurnsInFlight', () => {
  const b = createTestBridge({ CONTEXT_ROTATION_THRESHOLD: '8' });

  assert.deepEqual(
    { ...b.rotationState },
    {
      total: 0,
      lastAt: null,
      lastBefore: null,
      lastReason: null,
      lastError: null,
      inFlight: false,
    },
    'this.rotationState must be initialized in constructor with standard counters and flags'
  );
  assert.equal(b.typedTurnsInFlight, 0, 'this.typedTurnsInFlight must start at 0');
});

test('4.2 /health endpoint exposes conversation_rotation status block', async () => {
  const b = createTestBridge({ CONTEXT_ROTATION_THRESHOLD: '8' });
  attachMockSocket(b);

  const res = await b.fetch(new Request('https://test/health'));
  assert.equal(res.status, 200);
  const health = await res.json();

  assert.ok(health.conversation_rotation, '/health must expose conversation_rotation object');
  assert.equal(health.conversation_rotation.enabled, true);
  assert.equal(health.conversation_rotation.threshold, 8);
  assert.equal(typeof health.conversation_rotation.total, 'number');
});
