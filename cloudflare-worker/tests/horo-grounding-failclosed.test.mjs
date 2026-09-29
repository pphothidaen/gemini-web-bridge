// Conformance tests for docs/api-spec.md invariant G-1 (KAN-204).
//
// G-1: an accepted horo_consult answer must be notebook-grounded. Before this
// suite, a default-scoped horo_consult whose extension was offline (or whose
// model answer came back empty) still returned a *successful* GCP-fallback
// answer — fluent prose that cannot cite the HoroConsultant notebook, which is
// the exact leak the spec's IMPORTANT note warned consumers about. The fix
// gates all three GCP fallback sites in the MCP tools/call handler on
// `!wantsDefaultNotebook`, so a grounding-required call fails closed with
// -32000 while every other tool keeps the fallback.
//
// These tests stub the DO surface (waitForExtension / callGcpGemini /
// executeThroughExtension) the same way sdlc-tool-args.test.mjs does, so no
// live browser or network is involved.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as catalog from '../src/model-catalog.js';
import * as emulator from '../src/tool-emulator.ts';
import * as promptTemplates from '../src/prompt-templates.js';
import { makeCtx } from './helpers/fake-ctx.mjs';

const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const context = {
  ...catalog,
  ...emulator,
  ...promptTemplates,
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

// A DO whose extension is offline but whose GCP fallback is configured — the
// state in which the ungrounded-fallback leak used to fire.
function createGroundingBridge() {
  const b = new GeminiBridgeDO(makeCtx(), {
    CLIENT_API_KEY: 'secret-token-123',
    BRIDGE_SECRET: 'bridge-secret',
    GEMINI_API_KEY: 'gcp-test-key'
  });
  b.currentScope = 'app';
  b.waitForExtension = async () => {};
  b.callGcpGemini = async () => {
    throw new Error('callGcpGemini must not be reached; stub me per-test');
  };
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

const assertGcpUntouched = (b) => {
  assert.ok(!b.callGcpGemini.called, 'GCP fallback must not be reached for a grounding-required call');
};

// Flip the DO to the extension-ready state the sdlc-tool-args suite uses, so a
// call reaches executeThroughExtension instead of the offline branch.
const markExtensionReady = (b) => {
  b.currentTokens = { sessionReady: true };
  b.replaceModelCatalog({
    protocolVersion: 2,
    models: [{ id: 'gemini-web-thinking', name: 'Gemini Web Thinking', thinking: true, verification: 'verified', mapping_revision: 'rev-1' }]
  });
  b.activeSocket = { readyState: 1, send: () => {} };
};

test('default-scope horo_consult with the extension offline fails closed instead of GCP fallback', async () => {
  const b = createGroundingBridge();
  b.callGcpGemini = async () => { b.callGcpGemini.called = true; return 'fluent but ungrounded'; };

  // No `scope` argument → wantsDefaultNotebook → grounding required.
  const data = await callTool(b, 1, 'horo_consult', { query: 'อาชีพที่เหมาะกับดวงนี้' });

  assertGcpUntouched(b);
  assert.ok(data.error, 'expected an error, got: ' + JSON.stringify(data.result || data));
  assert.equal(data.error.code, -32000);
  assert.match(data.error.message, /grounded/i);
  assert.match(data.error.message, /GCP fallback/i);
});

test('empty model response on a grounding-required call fails closed instead of GCP fallback', async () => {
  const b = createGroundingBridge();
  markExtensionReady(b);
  b.runNotebookAttach = async () => ({ ok: true, attached: ['Horo'] });
  b.callGcpGemini = async () => { b.callGcpGemini.called = true; return 'fluent but ungrounded'; };
  b.executeThroughExtension = async () => '   ';

  const data = await callTool(b, 2, 'horo_consult', { query: 'โชควันนี้เป็นอย่างไร' });

  assertGcpUntouched(b);
  assert.ok(data.error, 'expected an error, got: ' + JSON.stringify(data.result || data));
  assert.equal(data.error.code, -32000);
  assert.match(data.error.message, /Empty model response/);
  assert.match(data.error.message, /deliberately skipped/);
});

test('explicit-scope horo_consult keeps the GCP fallback — no grounding is being claimed', async () => {
  const b = createGroundingBridge();
  b.callGcpGemini = async () => 'general-knowledge reading';

  // An explicit scope means no notebook attach and no grounding claim, so the
  // fallback must stay reachable (spec §2 scope table).
  const data = await callTool(b, 3, 'horo_consult', { query: 'คำถามทั่วไป', scope: 'app' });

  assert.ok(data.result, 'expected success, got: ' + JSON.stringify(data.error || data));
  assert.match(data.result.content[0].text, /\[Provider: GCP Gemini Fallback\]/);
  // No grounding block may be reported for a call that never attached.
  assert.equal(data.result.notebookGrounding, undefined);
});

test('other tools keep the GCP fallback when the extension is offline', async () => {
  const b = createGroundingBridge();
  b.callGcpGemini = async () => 'SDLC plan from GCP';

  const data = await callTool(b, 4, 'orchestrate_sdlc_plan', { feature_or_goal: 'Add OAuth login' });

  assert.ok(data.result, 'expected success, got: ' + JSON.stringify(data.error || data));
  assert.match(data.result.content[0].text, /\[Provider: GCP Gemini Fallback\]/);
});

test('a notebook attach failure fails closed and never reaches the GCP fallback', async () => {
  const b = createGroundingBridge();
  markExtensionReady(b);
  // Attach fails the way the extension reports it; the handler must surface
  // the attach error and must not drift onto the fallback provider.
  b.runNotebookAttach = async () => ({ ok: false, attached: [], step: 'send', reason: 'attach_send_failed' });
  b.callGcpGemini = async () => { b.callGcpGemini.called = true; return 'fluent but ungrounded'; };

  const data = await callTool(b, 6, 'horo_consult', { query: 'ดวงรายเดือน' });

  assertGcpUntouched(b);
  assert.ok(data.error, 'expected an error, got: ' + JSON.stringify(data.result || data));
  assert.equal(data.error.code, -32000);
  assert.match(data.error.message, /Could not attach the HoroConsultant notebook/);
});

test('a grounding-required empty response without GEMINI_API_KEY errors the same way', async () => {
  const b = new GeminiBridgeDO(makeCtx(), {
    CLIENT_API_KEY: 'secret-token-123',
    BRIDGE_SECRET: 'bridge-secret'
  });
  b.currentScope = 'app';
  b.waitForExtension = async () => {};
  markExtensionReady(b);
  b.runNotebookAttach = async () => ({ ok: true, attached: ['Horo'] });
  b.executeThroughExtension = async () => '';
  b.callGcpGemini = async () => { b.callGcpGemini.called = true; return 'fluent but ungrounded'; };

  const data = await callTool(b, 5, 'horo_consult', { query: 'ดวงคู่ของฉัน' });

  assertGcpUntouched(b);

  assert.ok(data.error, 'expected an error, got: ' + JSON.stringify(data.result || data));
  assert.equal(data.error.code, -32000);
  assert.match(data.error.message, /Empty model response/);
});
