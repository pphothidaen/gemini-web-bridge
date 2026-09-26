// Regression tests for ProtocolDecoder.decodeChunk (worker src/index.js).
//
// Context: the decoder used to take the LAST `wrb.fr` text in a buffer and the
// caller used to REPLACE its accumulator with that value. Gemini sends the
// cumulative answer, then can append a private conversation link
// (https://googleusercontent.com/lmdx_content/...) and emit LMDX UI-component
// entries in their own `wrb.fr`, so the accumulator could be replaced by that
// trailing fragment — long `orchestrate_sdlc_plan` output came back link-only.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as catalog from '../src/model-catalog.js';
import * as emulator from '../src/tool-emulator.ts';
import * as pdfLib from 'pdf-lib';

const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const context = {
  ...catalog,
  ...emulator,
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

const { ProtocolDecoder } = vm.runInNewContext(
  source.replace(/import[\s\S]*?from "[^"\n]+";/g, '')
    .replaceAll('export class ', 'class ')
    .replace('export default {', 'const entry = {') +
  '\n;({ProtocolDecoder})',
  context
);

// ── helpers ────────────────────────────────────────────────────────────────
const wrap = (inner) => JSON.stringify([["wrb.fr", "gen_ids", JSON.stringify(inner)]]);

// Canonical Google RPC shape used by the decoder:
//   inner[1]  = [conversationId, responseId]
//   inner[4]  = [ [choiceId, [text, ...]] ]
const innerWithText = (text, state = ["c_123", "r_1"]) =>
  [null, state, null, null, [["choice0", [text]]]];

const RPC_PREFIX = ")]}'\n";

// ── baseline ───────────────────────────────────────────────────────────────
test('decodeChunk: extracts cumulative text and state from a normal wrb.fr line', () => {
  const { deltaText, stateUpdate } = ProtocolDecoder.decodeChunk(
    RPC_PREFIX + wrap(innerWithText("Phase 1: Plan the SDLC work"))
  );
  assert.equal(deltaText, "Phase 1: Plan the SDLC work");
  assert.equal(stateUpdate.choiceId, "choice0");
  assert.equal(stateUpdate.conversationId, "c_123");
  assert.equal(stateUpdate.responseId, "r_1");
});

// ── regression: trailing lmdx_content link must not clobber the answer ─────
test('decodeChunk: keeps the longest text when a trailing lmdx_content link entry follows', () => {
  const plan = "FULL SDLC PLAN\n\n## Phase 1\nPlanning\n\n## Phase 2\nArchitecture";
  const buffer = [
    wrap(innerWithText(plan)),
    wrap(innerWithText("https://googleusercontent.com/lmdx_content/abc123"))
  ].join("\n");

  const { deltaText } = ProtocolDecoder.decodeChunk(buffer);
  assert.equal(deltaText, plan, "plan text must win over the trailing private link");
  assert.ok(!deltaText.includes("lmdx_content"), "private link must be stripped");
});

test('decodeChunk: strips a private lmdx_content link appended to the answer text', () => {
  const { deltaText } = ProtocolDecoder.decodeChunk(
    wrap(innerWithText("Here is your plan.\nhttps://googleusercontent.com/lmdx_content/deadbeef"))
  );
  assert.equal(deltaText, "Here is your plan.");
});

// ── regression: text slot shape variants must not corrupt output ───────────
test('decodeChunk: handles the text slot delivered as a plain string (not an array)', () => {
  const { deltaText } = ProtocolDecoder.decodeChunk(
    wrap([null, ["c_123", "r_1"], null, null, [["choice0", "PHASE 1 LONG PLAN"]]])
  );
  assert.equal(deltaText, "PHASE 1 LONG PLAN", "must not degrade to the first character");
});

test('decodeChunk: extracts text carried inside an lmdx_content structured block', () => {
  const { deltaText } = ProtocolDecoder.decodeChunk(
    wrap([null, ["c_123", "r_1"], null, null, [["choice0", [{ lmdx_content: [{ text: "Phase 3: QA" }] }]]]])
  );
  assert.equal(deltaText, "Phase 3: QA");
});

test('decodeChunk: joins multiple text segments in order', () => {
  const { deltaText } = ProtocolDecoder.decodeChunk(
    wrap([null, ["c_123", "r_1"], null, null, [["choice0", ["Phase 1 ", "Phase 2 ", "Phase 3"]]]])
  );
  assert.equal(deltaText, "Phase 1 Phase 2 Phase 3");
});

// ── regression: one malformed item must not discard the rest of the line ───
test('decodeChunk: a broken inner payload does not discard sibling entries or state', () => {
  const buffer = [
    '[["wrb.fr","gen_ids","{not-json"]]',
    wrap(innerWithText("recovered text"))
  ].join("\n");

  const { deltaText, stateUpdate } = ProtocolDecoder.decodeChunk(buffer);
  assert.equal(deltaText, "recovered text");
  assert.equal(stateUpdate.conversationId, "c_123");
});

test('decodeChunk: tolerates non-JSON and length-prefixed lines without throwing', () => {
  const buffer = ["1234", "not json at all", "", wrap(innerWithText("ok"))].join("\n");
  const { deltaText } = ProtocolDecoder.decodeChunk(buffer);
  assert.equal(deltaText, "ok");
});

test('decodeChunk: returns empty text (no throw) for an empty/unknown payload', () => {
  assert.equal(ProtocolDecoder.decodeChunk("").deltaText, "");
  assert.equal(ProtocolDecoder.decodeChunk(RPC_PREFIX).deltaText, "");
  assert.equal(ProtocolDecoder.decodeChunk('[["di",42],[null,null,null,1]]').deltaText, "");
});
