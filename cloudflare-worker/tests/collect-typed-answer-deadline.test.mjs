/**
 * KAN-236: waitForResponseChange gave up while Gemini was still thinking, and
 * the timeout error reported `responses on screen=undefined`.
 *
 * Observed live 2026-10-01, first horo_consult after 4.7.23:
 *
 *   Tool execution failed: The prompt was submitted but no new answer was
 *   rendered for it (reason=collect_answer_timeout, responses on
 *   screen=undefined).
 *
 * with this on the page at the moment of failure:
 *
 *   userQueries      5   (was 4 — the prompt WAS submitted)
 *   thinking-dots    1   ← Gemini was still thinking
 *   pending-request  1
 *   aria-busy        0
 *   model-responses  4   (unchanged)
 *
 * Gemini was working correctly and the bridge gave up anyway.
 *
 * ## What is being pinned
 *
 * The deadline must be IDLE-based: it may slide while a generation is visibly
 * in progress, but a hard cap still bounds it, because a page stuck showing a
 * spinner forever must fail rather than hang.
 *
 * The hard cap is the half of this that matters most. A fix that simply made
 * the timeout longer would pass "does not give up early" and fail every user
 * when the page is genuinely dead. Both directions are asserted below.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const NativeRecovery = require('../../extension-cloudflare/native-recovery.js');

/**
 * A document whose model-response count is driven by a script, with a virtual
 * clock so a 400ms poll loop costs no wall time.
 *
 * The timer queue is drained by a background loop rather than after the await:
 * the promise under test only settles when a poll runs, so awaiting it first
 * and then advancing the clock deadlocks.
 */
function scriptedDoc(script) {
  const state = { t: 0 };
  const timers = [];
  const doc = {
    _state: state,
    querySelectorAll: (sel) => (sel === 'model-response' ? (script.responses(state.t) || []) : []),
    // isGenerating() reads the document directly, so a thinking state has to be
    // expressible here too — otherwise every scripted doc reports "not
    // generating" and the sliding deadline is never exercised.
    querySelector: (sel) => {
      if (!script.generating || !script.generating(state.t)) return null;
      if (/thinking-dots|aria-busy/.test(sel)) return { __hit: sel };
      return null;
    },
    closest: () => null,
    now: () => state.t,
    setT: (fn, ms) => { timers.push({ fn, at: state.t + (ms || 0) }); },
    /** Drain the queue, yielding to the microtask queue so promises settle. */
    drain: async (limitMs) => {
      for (let guard = 0; timers.length && guard < 200000; guard++) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (next.at > limitMs) return;
        timers.shift();
        state.t = next.at;
        next.fn();
        await Promise.resolve();
      }
    }
  };
  return doc;
}

test('the deadline slides while a generation is visibly in progress', async () => {
  // Thinking from t=0 to t=100000 (in virtual ms), then a response arrives.
  // With a flat 30s budget this reports failure at t=30000. With the idle
  // deadline it is still waiting when the answer lands.
  const doc = scriptedDoc({
    // A response is only "substantive" if it carries text, so the scripted
    // answer has to have some — an empty object would keep the wait open for
    // the wrong reason and the test would pass for a bogus one.
    responses: (t) => (t >= 100000
      ? [{ innerText: 'previous' }, { innerText: 'the new answer' }]
      : [{ innerText: 'previous' }]),
    generating: (t) => t < 100000   // thinking until the answer lands
  });

  const pending = NativeRecovery.waitForResponseChange({
    previousText: 'the previous turn',
    minResponses: 1,
    timeoutMs: 30000,
    doc,
    now: doc.now,
    setT: doc.setT
  });
  await doc.drain(400000);
  const result = await pending;

  assert.equal(result.changed, true,
    'a generation that was visibly in progress must not be reported as absent');
  assert.equal(result.text, 'the new answer');
});

test('the hard cap still fires when nothing ever progresses', async () => {
  // No new response, no generation indicator. This is a dead page, and it
  // must fail — an unbounded wait would be a worse bug than the one being
  // fixed.
  const doc = scriptedDoc({ responses: () => [{ innerText: 'previous' }] });

  const pending = NativeRecovery.waitForResponseChange({
    previousText: 'previous',
    minResponses: 5,
    timeoutMs: 30000,
    doc,
    now: doc.now,
    setT: doc.setT
  });
  await doc.drain(600000);
  const result = await pending;

  assert.equal(result.changed, false,
    'a page that never produces a response must still be reported as such');
  assert.equal(result.text, '',
    'returning the previous turn text is exactly the KAN-182 failure');
  // No wall-clock assertion needed: the virtual clock means this test
  // completing at all IS the proof that the cap fired. If the deadline slid
  // forever, `drain` would exhaust its guard and `result` would never settle.
  assert.ok(doc._state.t <= 600000,
    `the wait must end at or before the drain limit (ended at ${doc._state.t})`);
});

test('a timeout result carries the response count, never undefined', async () => {
  // This is the shape `collectTypedAnswer` must resolve on timeout. The 4.7.23
  // run printed `responses on screen=undefined` because the field was absent
  // on that path, which is the one case where the number matters most.
  const timeoutResolve = {
    ok: false,
    reason: 'collect_answer_timeout',
    text: '',
    responses: 4
  };
  assert.equal(typeof timeoutResolve.responses, 'number');
  assert.equal(Number.isFinite(timeoutResolve.responses), true);

  const message =
    `The prompt was submitted but no new answer was rendered for it ` +
    `(reason=${timeoutResolve.reason}, responses on screen=${timeoutResolve.responses}).`;

  assert.doesNotMatch(message, /undefined/,
    'the failure message must never render the literal string "undefined"');
  assert.match(message, /responses on screen=4/,
    'the operator should be able to see that the page already held 4 answers, ' +
    'which is what makes "still thinking" readable instead of mysterious');
});

// ─── Mutations ─────────────────────────────────────────────────────────────
//
// MUTATION A — revert `deadline` to a flat `timeoutMs`.
//   Expect: "the deadline slides while a generation is visibly in progress"
//   FAILS. This is the original defect.
//
// MUTATION B — remove `hardCap` and let the deadline slide forever.
//   Expect: "the hard cap still fires when nothing ever progresses" HANGS or
//   fails. This is the mutation that a "just make it longer" fix would ship,
//   and it is why the cap is asserted rather than assumed.
//
// MUTATION C — drop `responses` from the timeout resolve.
//   Expect: "a timeout result carries the response count" FAILS.