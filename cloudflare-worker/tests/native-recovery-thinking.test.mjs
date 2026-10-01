/**
 * KAN-235: isGenerating() was silent during the thinking phase.
 *
 * The shipped signal is `[aria-busy="true"]` scoped to the newest
 * `model-response`. Measured 2026-10-01 across one real generation, that is
 * false for the entire thinking phase — and during that phase there is no new
 * model-response at all, so the scope has nothing to look at:
 *
 *   T1 thinking   aria-busy=0  model-response=3 (unchanged)  thinking-dots=1
 *   T2 streaming  aria-busy=1  model-response=4               thinking-dots=0
 *   T3 settled    aria-busy=0  model-response=4               thinking-dots=0
 *
 * So between "prompt submitted" and "aria-busy fires", the extension reads a
 * settled-looking page. This is KAN-197/198 one level up: a proxy read as the
 * state itself.
 *
 * ## The failure this must not reintroduce
 *
 * 4.7.13 keyed on `processing-state-visible` and `has-thoughts`, which are
 * permanent. isGenerating() became true forever, handleCollectAnswer burned
 * its 120s budget, and every call failed with collect_answer_timeout on
 * answers finished for a minute.
 *
 * `thinking-dots-animation` is transient — removed the moment streaming
 * starts — so it cannot latch. The `settled` state in the fixture carries no
 * such node, and that is asserted below as the regression case, not assumed.
 *
 * Every assertion drives the REAL `generatingSignal` against a stub built from
 * the capture, so a change that matches the code's own behaviour rather than
 * the measurement fails here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { buildStubFromFixture, REPO_ROOT } from './helpers/dom-signal.mjs';

const require = createRequire(import.meta.url);
const NativeRecovery = require('../../extension-cloudflare/native-recovery.js');

const FIXTURE = JSON.parse(
  fs.readFileSync(join(REPO_ROOT, 'cloudflare-worker', 'tests', 'fixtures', 'prompt-typing.json'), 'utf8')
);

const signalFor = (state) => NativeRecovery.generatingSignal(buildStubFromFixture(FIXTURE, state));

test('isGenerating() is TRUE while Gemini is thinking (the phase aria-busy misses)', () => {
  const sig = signalFor('thinking');
  assert.equal(sig.active, true,
    'a visible thinking indicator means Gemini is working, whatever aria-busy says');
  assert.equal(sig.source, 'pending_thinking_dots',
    'the source must name the thinking signal, so a log line shows which one fired');
});

test('isGenerating() is TRUE while streaming, and still uses the aria-busy signal', () => {
  // The new check must not have displaced the existing one. If this ever
  // reports pending_thinking_dots, the ordering is wrong — the thinking check
  // is meant to fire only when the newest response looks settled.
  const sig = signalFor('streaming');
  assert.equal(sig.active, true);
  assert.equal(sig.source, 'response_aria_busy');
});

test('REGRESSION: isGenerating() is FALSE once the answer is finished', () => {
  // This is the 4.7.13 failure, restated. Any signal that latches true here
  // reproduces the incident that stopped the bridge answering.
  const sig = signalFor('settled');
  assert.equal(sig.active, false,
    'a finished answer must read as finished — the 4.7.13 failure was exactly this returning true');
});

test('isGenerating() is FALSE at the input surface, in both editor states', () => {
  // Typing a prompt is not generating. A document-wide thinking check that
  // also fired on the editor would make every typed-but-unsent prompt look
  // like an in-flight generation.
  for (const state of ['empty', 'filled']) {
    const sig = signalFor(state);
    assert.equal(sig.active, false, `${state} must not read as generating`);
    assert.equal(sig.source, 'none');
  }
});

test('the permanent classes still mean nothing', () => {
  // processing-state-visible is present on the settled responses in this very
  // capture. If a future change keys on it, this fails — which is the point.
  const settled = FIXTURE.states.settled.nodes
    .flatMap((n) => [n, ...(n.children || [])]);
  const classes = settled.map((n) => String(n.class || '')).join(' ');
  assert.match(classes, /processing-state-visible/,
    'the capture is only a useful regression case if the permanent class is really in it');
  assert.equal(signalFor('settled').active, false,
    'and it must still read as finished despite that class being present');
});

test('the capture orders responses oldest-first, as the live page does', () => {
  // lastModelResponse takes all[all.length - 1], so document order decides
  // which response is "newest". The capture initially listed the streaming
  // response first, which made the scoped query look at a settled response
  // and report "not generating" for a visibly streaming answer.
  const streaming = FIXTURE.states.streaming.nodes.filter((n) => n.tag === 'model-response');
  assert.ok(streaming.length >= 2, 'the capture needs an older response for scope to be meaningful');
  const last = streaming[streaming.length - 1];
  const busy = JSON.stringify(last);
  assert.match(busy, /"aria-busy":\s*"true"/,
    'the LAST response in the capture must be the busy one, or the fixture is mis-ordered');
});

// ─── Mutations ─────────────────────────────────────────────────────────────
//
// MUTATION A — delete the thinking-dots check from generatingSignal.
//   Expect: "isGenerating() is TRUE while Gemini is thinking" FAILS, and only
//   that one. The other four pin behaviour the check must not disturb.
//
// MUTATION B — move the thinking-dots check ABOVE the response-scoped block.
//   Expect: "isGenerating() is TRUE while streaming" FAILS on its source —
//   the thinking check would mask response_aria_busy even though no thinking
//   indicator is present, because it is consulted first.
//
// MUTATION C — key the thinking check on `processing-state-visible` instead.
//   Expect: "REGRESSION: isGenerating() is FALSE once the answer is finished"
//   FAILS. That reproduces 4.7.13 and this test is the one that catches it.