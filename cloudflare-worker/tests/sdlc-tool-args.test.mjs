// Regression tests for the SDLC tool argument contract and for the
// empty/short model-response guard.
//
// 1. README.md/HANDOFF.md documented `problem_description` for every SDLC
//    tool while the schemas used per-tool names. orchestrate_sdlc_plan
//    therefore received undefined and prompted "Goal: undefined".
// 2. A tool result that decoded to "" (pure LMDX component answer, empty model
//    reply, or a clobbered accumulator) used to be returned as a *successful*
//    but contentless MCP result.

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
  const b = new GeminiBridgeDO(makeCtx(), { CLIENT_API_KEY: 'secret-token-123', BRIDGE_SECRET: 'bridge-secret' });
  b.currentTokens = { sessionReady: true };
  b.replaceModelCatalog({
    protocolVersion: 2,
    models: [{ id: 'gemini-web-thinking', name: 'Gemini Web Thinking', thinking: true, verification: 'verified', mapping_revision: 'rev-1' }]
  });
  b.activeSocket = { readyState: 1, send: () => {} };
  b.currentScope = 'app';
  return b;
}

const postMcp = (b, body) => b.fetch(new Request('https://test/mcp', {
  method: 'POST',
  headers: { Authorization: 'Bearer secret-token-123', 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
}));

const callTool = async (b, id, name, args) => {
  const res = await postMcp(b, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  return res.json();
};

test('orchestrate_sdlc_plan: accepts the documented problem_description alias and forwards it to Gemini', async () => {
  const b = createBridge();
  let prompt = null;
  b.executeThroughExtension = async (messages) => { prompt = messages[0].content; return 'SDLC plan'; };

  const data = await callTool(b, 90, 'orchestrate_sdlc_plan', { problem_description: 'Add OAuth login' });
  assert.ok(data.result, 'expected success, got: ' + JSON.stringify(data.error || data));
  // The alias must reach Gemini as prose, not as a relabelled "Goal:" field.
  assert.match(prompt, /Add OAuth login/);
  assert.ok(!/undefined/.test(prompt), 'prompt must not contain "undefined": ' + prompt);
});

test('orchestrate_sdlc_plan: still honours the canonical feature_or_goal argument', async () => {
  const b = createBridge();
  let prompt = null;
  b.executeThroughExtension = async (messages) => { prompt = messages[0].content; return 'SDLC plan'; };

  const data = await callTool(b, 91, 'orchestrate_sdlc_plan', { feature_or_goal: 'Ship billing' });
  assert.ok(data.result, 'expected success, got: ' + JSON.stringify(data.error || data));
  assert.match(prompt, /Ship billing/);
});

test('sdlc tools: a missing required argument returns -32602 instead of prompting "undefined"', async () => {
  const b = createBridge();
  let executed = false;
  b.executeThroughExtension = async () => { executed = true; return 'should not happen'; };

  for (const [id, name, expected] of [
    [92, 'orchestrate_sdlc_plan', 'feature_or_goal'],
    [93, 'sdlc_solution_architect', 'problem_description'],
    [94, 'code_review_and_debug', 'code_snippet'],
    [95, 'evaluate_tech_tradeoffs', 'decision_context']
  ]) {
    const data = await callTool(b, id, name, {});
    assert.ok(data.error, `${name} expected an error, got: ` + JSON.stringify(data));
    assert.equal(data.error.code, -32602);
    assert.match(data.error.message, new RegExp(expected));
  }
  assert.equal(executed, false, 'the worker must not call Gemini with an undefined argument');
});

test('sdlc tools: an empty model response returns an error, never a blank success', async () => {
  const b = createBridge();
  for (const answer of ['', '   \n  ', null, undefined]) {
    b.executeThroughExtension = async () => answer;
    const data = await callTool(b, 96, 'orchestrate_sdlc_plan', { feature_or_goal: 'g' });
    assert.ok(data.error, `empty answer must not succeed (${JSON.stringify(answer)})`);
    assert.equal(data.error.code, -32000);
    assert.match(data.error.message, /Empty model response/);
  }
  assert.equal(b.healthState.consecutiveErrors, 4, 'empty answers must be counted in health metrics');
});

test('sdlc tools: a link-only (lmdx_content) answer is rejected as empty after stripping', async () => {
  const b = createBridge();
  b.executeThroughExtension = async () => 'https://googleusercontent.com/lmdx_content/abc123';
  const data = await callTool(b, 97, 'orchestrate_sdlc_plan', { feature_or_goal: 'g' });
  assert.ok(data.error, 'a bare private link is not a usable answer');
  assert.equal(data.error.code, -32000);
});

test('sdlc tools: a real answer is trimmed and returned with bridgeScope', async () => {
  const b = createBridge();
  b.executeThroughExtension = async () => '\n\n## Phase 1\nPlanning\n';
  const data = await callTool(b, 98, 'orchestrate_sdlc_plan', { feature_or_goal: 'g' });
  assert.ok(data.result, 'expected success, got: ' + JSON.stringify(data.error || data));
  assert.equal(data.result.content[0].text, '## Phase 1\nPlanning');
  assert.equal(data.result.bridgeScope.active, 'app');
});

// ── schema 'required' vs actual enforcement ──────────────────────────────────
// Both tools below declare a required argument in their tools/list
// inputSchema, but neither enforced it:
//
//   set_bridge_scope  required: ["scope"]  — applyScope(undefined) short-circuits
//                      to `{ ok: true, scope: currentScope }`, so the call
//                      reported success while doing nothing. A client with a typo
//                      in the argument name got "Bridge is now scoped to 'app'"
//                      and no indication that its scope was never applied.
//
//   horo_consult      required: ["query"]  — no check at all, so the prompt was
//                      built with "User Question: undefined" and the worker paid
//                      a Notebook scope switch plus a full Gemini round-trip to
//                      return -32000 "Active Gemini session is not ready" — an
//                      upstream error that sends the caller to debug their
//                      browser instead of their payload.

test('set_bridge_scope: a missing required scope returns -32602 instead of a silent no-op success', async () => {
  const b = createBridge();
  const before = b.currentScope;

  for (const args of [{}, { scope: '' }, { scope: '   ' }, { scope: null }]) {
    const data = await callTool(b, 100, 'set_bridge_scope', args);
    assert.ok(data.error, `scope=${JSON.stringify(args)} expected an error, got: ${JSON.stringify(data)}`);
    assert.equal(data.error.code, -32602);
    assert.match(data.error.message, /Missing required argument 'scope'/);
  }
  assert.equal(b.currentScope, before, 'a rejected call must not touch the scope');
});

test('horo_consult: a missing required query returns -32602 without calling Gemini', async () => {
  const b = createBridge();
  let executed = false;
  let prompt = null;
  let scopePrepared = false;
  // The guard must fire BEFORE prepareScope: a rejected call must not navigate
  // the user's browser tab to the HoroConsultant Notebook as a side effect.
  b.prepareScope = async (scope) => { scopePrepared = true; return { scope }; };
  b.executeThroughExtension = async (messages) => { executed = true; prompt = messages[0].content; return 'answer'; };

  for (const args of [{}, { query: '' }, { query: '   ' }, { query: null }]) {
    const data = await callTool(b, 101, 'horo_consult', args);
    assert.ok(data.error, `query=${JSON.stringify(args)} expected an error, got: ${JSON.stringify(data)}`);
    assert.equal(data.error.code, -32602);
    assert.match(data.error.message, /Missing required argument 'query'/);
  }
  assert.equal(executed, false, 'the worker must not spend a Gemini round-trip on an undefined query');
  assert.equal(scopePrepared, false, 'a rejected horo_consult must not switch the browser to the Notebook scope');
  assert.equal(b.currentScope, 'app', 'a rejected horo_consult must not change the session scope');
  assert.ok(!/undefined/.test(prompt ?? ''), 'prompt must never contain "undefined"');
});

test('horo_consult: a valid query still reaches Gemini (the required-arg guard does not over-reject)', async () => {
  const b = createBridge();
  // horo_consult attaches the HoroConsultant notebook to the open conversation
  // before asking, so the attach must be stubbed — the real one drives the
  // browser UI and would block for its full 45s timeout in a unit test.
  // prepareScope is stubbed too, for the explicit-scope path.
  b.prepareScope = async (scope) => ({ scope });
  b.runNotebookAttach = async () => ({ ok: true, attached: ['Horo'] });
  b.verifyNotebookGrounding = async () => ({ ok: true, verified: true, reason: '', chipCount: 1, citeMarkers: 1, sources: ['Horo'] });
  let prompt = null;
  b.executeThroughExtension = async (messages) => { prompt = messages[0].content; return 'หัวใจ: น้ำ ดิน ไฟ'; };

  const data = await callTool(b, 102, 'horo_consult', { query: 'ชะตาของฉันเป็นอย่างไร' });
  assert.ok(data.result, 'expected success, got: ' + JSON.stringify(data.error || data));
  assert.match(prompt, /ชะตาของฉันเป็นอย่างไร/);
  assert.ok(!/undefined/.test(prompt), 'prompt must not contain "undefined": ' + prompt);
});

