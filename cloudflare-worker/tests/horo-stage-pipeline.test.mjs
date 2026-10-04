// Conformance tests for the horo_consult atomic stage pipeline (KAN-204).
//
// prompts/ split the fate book into five atomic requests because the full
// document in one request grounded with 0 citations while a narrow question
// grounded with 5. The pipeline runs the five stage prompts (generated from
// prompts/0*.md into src/horo-prompts.js) as separate notebook-attached
// typed-path calls, verifies grounding per stage, persists each answer in DO
// storage, and assembles the document under the reading's title.
//
// These tests stub the DO surface (waitForExtension / runNotebookAttach /
// executeThroughExtension / verifyNotebookGrounding) the same way
// horo-grounding-failclosed.test.mjs does — no live browser or network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as catalog from '../src/model-catalog.js';
import * as emulator from '../src/tool-emulator.ts';
import * as promptTemplates from '../src/prompt-templates.js';
import * as horoPrompts from '../src/horo-prompts.js';
import { makeCtx } from './helpers/fake-ctx.mjs';

const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const context = {
  ...catalog,
  ...emulator,
  ...promptTemplates,
  ...horoPrompts,
  DurableObject: class {},
  crypto,
  Request,
  Response,
  URL,
  TextEncoder,
  TextDecoder,
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

const BIRTH_CONTEXT = {
  birth_datetime: '1997-05-10T08:30:00+07:00',
  longitude: 100.5018,
  utc_offset_hours: 7,
  day_master: 'Jia Wood',
  five_elements: 'wood 3, fire 1, earth 2, metal 1, water 1',
  birth_place: 'กรุงเทพมหานคร'
};

// A DO with KV-backed DO storage (fake-ctx.mjs only implements the alarm
// surface; the pipeline persists stage records via storage.get/put) and the
// browser side stubbed out.
function createPipelineBridge() {
  const ctx = makeCtx();
  const kv = new Map();
  ctx.storage.get = async (key) => kv.get(key);
  ctx.storage.put = async (key, value) => { kv.set(key, value); };
  ctx.storage.delete = async (key) => { kv.delete(key); };
  ctx.__kv = kv;

  const b = new GeminiBridgeDO(ctx, {
    CLIENT_API_KEY: 'secret-token-123',
    BRIDGE_AUTH_TOKEN: 'bridge-secret'
  });
  b.currentScope = 'app';
  b.activeSocket = { readyState: 1, send: () => {} };
  b.currentTokens = 'test-token';
  b.waitForExtension = async () => {};
  b.ensureConversationHeadroom = async () => {};
  b.prepareScope = async (scope) => ({ scope });

  const calls = { attaches: [], prompts: [], groundings: 0 };
  b.runNotebookAttach = async ({ notebookName }) => {
    calls.attaches.push(notebookName);
    return { ok: true, attached: [notebookName] };
  };
  b.verifyNotebookGrounding = async () => {
    calls.groundings += 1;
    return { ok: true, verified: true, reason: '', chipCount: 3, citeMarkers: 3, sources: ['Horo'] };
  };
  b.__calls = calls;
  return b;
}

const postMcp = (b, body) => b.fetch(new Request('https://test/mcp', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer secret-token-123', 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
}));

async function callTool(b, id, name, args) {
  const res = await postMcp(b, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(res.status, 200);
  return res.json();
}

// ─── Argument validation ───────────────────────────────────────────────────

test('stage mode requires birth_context.birth_datetime', async () => {
  const b = createPipelineBridge();
  const data = await callTool(b, 1, 'horo_consult', { stage: 'birth-chart' });
  assert.ok(data.error, 'expected -32602, got: ' + JSON.stringify(data.result || data));
  assert.equal(data.error.code, -32602);
  assert.match(data.error.message, /birth_context\.birth_datetime/);
});

test('an unknown stage name is a loud -32602, not a silent free-form fallback', async () => {
  const b = createPipelineBridge();
  const data = await callTool(b, 2, 'horo_consult', {
    stage: 'destiny',
    birth_context: BIRTH_CONTEXT
  });
  assert.equal(data.error.code, -32602);
  assert.match(data.error.message, /Invalid 'stage'/);
});

// ─── Single stage ──────────────────────────────────────────────────────────

test('single stage: typed-path call carries the atomic stage prompt and grounding proof', async () => {
  const b = createPipelineBridge();
  b.executeThroughExtension = async (messages) => {
    b.__calls.prompts.push(messages[0].content);
    return '## แผนภูมิกำเนิด (Birth Chart)\nสี่เสา: ดิน-ไม้-ไฟ-น้ำ';
  };

  const data = await callTool(b, 3, 'horo_consult', {
    stage: 'birth-chart',
    name: 'คุณทดสอบ',
    birth_context: BIRTH_CONTEXT
  });

  assert.ok(data.result, 'expected success, got: ' + JSON.stringify(data.error || data));
  assert.equal(b.__calls.attaches.length, 1, 'exactly one notebook attach for one stage');
  const prompt = b.__calls.prompts[0];
  // The prompt is the atomic template, not the free-form mega-prompt.
  assert.ok(prompt.startsWith('ตรวจสอบด้วยวิธีการของคุณเท่านั้น'), 'stage prompt opens with the method-only guardrail');
  assert.ok(prompt.includes('คุณทดสอบ เกิด 1997-05-10 เวลา 08:30'), 'name/birth data interpolated');
  assert.ok(prompt.includes('day_master: Jia Wood'), 'engine birth_context carried as context');
  assert.ok(prompt.includes('อ้างอิงแหล่งที่มาใน Notebook ทุกประเด็น'), 'citation clause present');
  assert.ok(prompt.includes('## แผนภูมิกำเนิด (Birth Chart)'), 'fixed assembly heading requested');
  assert.doesNotMatch(prompt, /Act as ซินแส AI/, 'must not be the legacy mega-prompt');

  assert.equal(data.result.structuredContent.stage, 'birth-chart');
  assert.equal(data.result.structuredContent.stages['birth-chart'].status, 'grounded');
  assert.ok(data.result.structuredContent.reading_id, 'reading_id is returned for resume');
  assert.equal(data.result.notebookGrounding.verified, true);

  // Persisted for a later resume.
  const stored = await b.ctx.storage.get(`horo_reading:${data.result.structuredContent.reading_id}`);
  assert.equal(stored.stages['birth-chart'].status, 'grounded');
  assert.match(stored.stages['birth-chart'].text, /แผนภูมิกำเนิด/);
});

// ─── Full pipeline ─────────────────────────────────────────────────────────

test('full pipeline: five separate attaches, five typed-path calls, one assembled document', async () => {
  const b = createPipelineBridge();
  const headingList = Object.values(horoPrompts.HORO_STAGE_HEADINGS);
  b.executeThroughExtension = async (messages) => {
    b.__calls.prompts.push(messages[0].content);
    // A grounded stage answer opens with its fixed assembly heading.
    return `## ${headingList[b.__calls.prompts.length - 1]}\nข้อความ`;
  };

  const data = await callTool(b, 4, 'horo_consult', {
    stage: 'full',
    title: 'หนังสือดวงชะตาของคุณทดสอบ',
    birth_context: BIRTH_CONTEXT
  });

  assert.ok(data.result, 'expected success, got: ' + JSON.stringify(data.error || data));
  assert.equal(b.__calls.attaches.length, 5, 'the notebook is consumed per message: one attach per stage');
  assert.equal(b.__calls.prompts.length, 5);
  for (const stageId of horoPrompts.HORO_STAGE_IDS) {
    assert.ok(
      b.__calls.prompts.some((p) => p.includes(horoPrompts.HORO_STAGE_TEMPLATES[stageId].template.slice(0, 40))),
      `the ${stageId} atomic prompt must be typed as its own request`
    );
  }

  const text = data.result.content[0].text;
  assert.ok(text.startsWith('# หนังสือดวงชะตาของคุณทดสอบ'), 'document opens with the caller title');
  for (const heading of Object.values(horoPrompts.HORO_STAGE_HEADINGS)) {
    assert.ok(text.includes(`## ${heading}`), `assembled text carries the ${heading} section`);
  }
  assert.match(text, /reading_id: [a-f0-9]{16}/, 'footer exposes the reading_id for resume');
  assert.equal(data.result.notebookGrounding.verified, true, 'all five stages grounded');
  assert.equal(data.result.notebookGrounding.citationCount, 15, 'citations summed across stages');
});

test('full pipeline: a stage that never grounds fails the whole call loudly (G-1: no fallback)', async () => {
  const b = createPipelineBridge();
  b.executeThroughExtension = async (messages) => {
    b.__calls.prompts.push(messages[0].content);
    return 'fluent answer with no citations';
  };
  b.verifyNotebookGrounding = async () => ({ ok: false, verified: false, reason: 'no_citations', chipCount: 0 });

  const data = await callTool(b, 5, 'horo_consult', { stage: 'full', birth_context: BIRTH_CONTEXT });
  assert.ok(data.error, 'expected -32000, got: ' + JSON.stringify(data.result || data));
  assert.equal(data.error.code, -32000);
  assert.match(data.error.message, /grounded no stage/);
  // Two attempts per stage (one retry each), five stages: 10 typed calls,
  // never a GCP fallback.
  assert.equal(b.__calls.prompts.length, 10);
  assert.match(data.error.message, /birth-chart: no_citations_in_response/);
});

test('full pipeline: one failed stage costs only that section and the rest still assemble', async () => {
  const b = createPipelineBridge();
  let n = 0;
  b.executeThroughExtension = async (messages) => {
    n += 1;
    return `answer ${n}`;
  };
  // Fail only turning-points on both attempts.
  b.verifyNotebookGrounding = async ({ requestId }) => ({
    ok: true,
    verified: !String(requestId).includes('turning-points'),
    reason: String(requestId).includes('turning-points') ? 'no_citations' : '',
    chipCount: String(requestId).includes('turning-points') ? 0 : 3
  });

  const data = await callTool(b, 6, 'horo_consult', { stage: 'full', birth_context: BIRTH_CONTEXT });
  assert.ok(data.result, 'partial success must return a result, got: ' + JSON.stringify(data.error || data));
  assert.equal(data.result.notebookGrounding.verified, false, 'one failed stage means not fully verified');
  const text = data.result.content[0].text;
  assert.match(text, /จุดเปลี่ยน.*FAILED \(no_citations_in_response\)/, 'failed stage is reported in the footer');
  assert.ok(text.includes('answer 1'), 'the grounded sections still assemble');
});

// ─── Resume ────────────────────────────────────────────────────────────────

test('resume_reading reruns only the failed stage and keeps the grounded ones', async () => {
  const b = createPipelineBridge();
  let n = 0;
  b.executeThroughExtension = async (messages) => {
    n += 1;
    b.__calls.prompts.push(messages[0].content);
    return `answer ${n}`;
  };
  const failStage = (stage) => b.verifyNotebookGrounding = async ({ requestId }) => ({
    ok: true,
    verified: !String(requestId).includes(stage),
    reason: String(requestId).includes(stage) ? 'no_citations' : '',
    chipCount: String(requestId).includes(stage) ? 0 : 3
  });

  // Run 1: base-fortune fails.
  failStage('base-fortune');
  const run1 = await callTool(b, 7, 'horo_consult', { stage: 'full', birth_context: BIRTH_CONTEXT });
  const readingId = run1.result.structuredContent.reading_id;
  const groundedBefore = run1.result.content[0].text.split('\n').length;

  // Run 2: everything grounds; resume skips the four already-grounded stages.
  failStage('__none__');
  const callsBefore = b.__calls.prompts.length;
  const run2 = await callTool(b, 8, 'horo_consult', {
    stage: 'full',
    reading_id: readingId,
    resume_reading: true,
    birth_context: BIRTH_CONTEXT
  });
  const newCalls = b.__calls.prompts.length - callsBefore;
  assert.equal(newCalls, 1, 'only the failed stage is rerun, and its retry is not spent when it grounds');
  assert.ok(run2.result, 'resume run succeeds, got: ' + JSON.stringify(run2.error || run2));
  assert.equal(run2.result.notebookGrounding.verified, true, 'all stages grounded after resume');
  assert.ok(run2.result.notebookGrounding.stages['birth-chart'].skipped === 'already_grounded');
  assert.notEqual(run2.result.content[0].text.length, groundedBefore, 'footer changes once the section grounds');
});

test('a reading_id bound to a different birth_context is rejected', async () => {
  const b = createPipelineBridge();
  // The fingerprint check must fire before any browser round trip; this stub
  // would hang the test on the real typed path if it did not.
  b.executeThroughExtension = async () => 'unused';
  const first = await callTool(b, 9, 'horo_consult', { stage: 'birth-chart', birth_context: BIRTH_CONTEXT });
  const readingId = first.result.structuredContent.reading_id;

  const data = await callTool(b, 10, 'horo_consult', {
    stage: 'birth-chart',
    reading_id: readingId,
    birth_context: { ...BIRTH_CONTEXT, birth_datetime: '1980-01-01T12:00:00+07:00' }
  });
  assert.equal(data.error.code, -32602);
  assert.match(data.error.message, /belongs to a different name\/birth_context/);
});
