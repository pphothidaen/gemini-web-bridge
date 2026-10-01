/**
 * KAN-233: the typed path had no success writer, so `horo_consult` could
 * raise the error counter but never clear it.
 *
 * Measured live on 2026-10-01. After four calls — three that failed at
 * `send_button`, then one that fully succeeded — `/health` reported:
 *
 *   status                     degraded
 *   consecutive_errors         3
 *   last_successful_generation null
 *   last_error                 type_prompt_failed:send_button_not_found@send_button
 *
 * The success was real: `notebookGrounding.verified: true`, 5 citations,
 * `attachedInPlace: true`, a 7537-character answer. The counters were the
 * exact values left by the three failures.
 *
 * ## Why it survived a green suite
 *
 * `recordHealthSuccess()` existed and was called — but only from the replay
 * stream's `STREAM_DONE` branch. A grounding-required call throws
 * `replay_skipped_for_grounding` before ever reaching the replay path, so it
 * always takes the typed path, and the typed path had only two
 * `recordHealthError` calls and no success writer at all.
 *
 * `health-metrics.test.mjs` tests the writers directly. It never drives a
 * call through a path and then asserts what the counters did. That is the gap
 * this file closes: every test here goes through `executeThroughExtension`.
 *
 * ## Why the assertion is on the exit, not the entry
 *
 * The fix records success at the single exit both paths reach, after the
 * verdict classification. A test that only checked "counters reset after a
 * good call" would pass against a fix placed anywhere. These tests also pin
 * the two properties that make the placement correct rather than merely
 * effective: a refusal must NOT clear the error, and a dropped-update signal
 * must survive the success write.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMockWorker, connectFakeExtension } from './helpers/mock-worker.mjs';

const MODEL = 'gemini-3.8-flash';

// Drive a real round trip through the replay path and return the final health
// snapshot. Replay is used rather than the typed path because the mock
// extension speaks the streaming protocol directly; the typed path drives real
// DOM injection that the mock cannot perform. Both paths converge on the same
// exit, which is what the single-exit assertions below verify.
async function runRoundTrip(worker, text) {
  await connectFakeExtension(worker, { onExecute: () => ({ text, delayMs: 0 }) });
  const res = await worker.fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${worker.CLIENT_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const body = await res.json();
  return { status: res.status, body, health: worker.bridge.healthState };
}

test('a successful round trip clears the error counter', async () => {
  const worker = createMockWorker();
  try {
    // Three failures first, so the counter is genuinely above the degraded
    // threshold. Asserting a reset from a standing start would pass even if
    // the writer never fired.
    worker.bridge.recordHealthError('transient failure 1');
    worker.bridge.recordHealthError('transient failure 2');
    worker.bridge.recordHealthError('transient failure 3');
    assert.equal(worker.bridge.healthState.consecutiveErrors, 3);

    const { status, health } = await runRoundTrip(worker, 'a complete and ordinary answer');

    assert.equal(status, 200);
    assert.equal(health.consecutiveErrors, 0,
      'a successful generation must clear the error counter');
    assert.equal(health.lastError, null,
      'a success must clear the stale error message, or /health keeps naming a failure that no longer applies');
    assert.notEqual(health.lastSuccessfulGeneration, null,
      'a successful generation must stamp last_successful_generation');
  } finally {
    await worker.dispose();
  }
});

test('a success after errors returns /health from degraded to healthy', async () => {
  const worker = createMockWorker();
  try {
    worker.bridge.recordHealthError('e1');
    worker.bridge.recordHealthError('e2');
    worker.bridge.recordHealthError('e3');

    const before = await (await worker.fetch('/health')).json();
    assert.equal(before.health_metrics.consecutive_errors, 3);

    await runRoundTrip(worker, 'an ordinary answer with no problems');

    const after = await (await worker.fetch('/health')).json();
    assert.equal(after.health_metrics.consecutive_errors, 0);
    assert.equal(after.health_metrics.last_error, null);
    assert.notEqual(after.health_metrics.last_successful_generation, null);

    // The derived status is what an operator actually reads. `degraded` is
    // emitted at >= 3 consecutive errors, so this is the assertion that the
    // latch is actually broken rather than merely the counter moving.
    assert.notEqual(after.health_metrics.consecutive_errors >= 3, true,
      'counters are still at the degraded threshold after a success');
  } finally {
    await worker.dispose();
  }
});

test('a refusal stays an error and is not cleared by the success write', async () => {
  const worker = createMockWorker();
  try {
    const { status, health } = await runRoundTrip(
      worker,
      "I'm sorry, I can't help with that request.",
    );

    assert.equal(status, 200);
    // The write must NOT have run: this text is classified as a hard refusal,
    // so `recordHealthError` fired instead and `lastError` names it. If the
    // success write were above the verdict check this would be null — which
    // is exactly the assertion below, stated directly.
    assert.match(health.lastError ?? '', /^gemini_hard_refusal:/,
      'a refusal must remain an error, not be laundered into a clean health report');
    assert.equal(health.consecutiveErrors, 1);
    assert.equal(health.lastSuccessfulGeneration, null,
      'a refusal must not stamp a successful generation');
  } finally {
    await worker.dispose();
  }
});

test('an empty answer does not count as a success', async () => {
  const worker = createMockWorker();
  try {
    worker.bridge.recordHealthError('prior failure');

    const { health } = await runRoundTrip(worker, '');

    // An empty generation is not a success. Whether the classifier calls it a
    // refusal or an error, it must not stamp lastSuccessfulGeneration —
    // otherwise a bridge returning nothing reports itself as healthy.
    assert.equal(health.lastSuccessfulGeneration, null,
      'an empty answer must never stamp a successful generation');
    assert.notEqual(health.lastError, null,
      'an empty answer must be recorded as something went wrong');
  } finally {
    await worker.dispose();
  }
});

test('the health state a reader sees matches the writers, with no drift', async () => {
  const worker = createMockWorker();
  try {
    // `healthState` is a DERIVED getter — it rebuilds an object on every read.
    // The KAN-202 comment records that writing through it mutated a throwaway
    // copy and pinned the counters at 0/null forever. This asserts the writers
    // still reach the fields a reader actually reads.
    worker.bridge.recordHealthError('one');
    worker.bridge.recordHealthError('two');

    const health = await (await worker.fetch('/health')).json();
    assert.equal(health.health_metrics.consecutive_errors, 2);
    assert.equal(health.health_metrics.last_error, 'two');

    await runRoundTrip(worker, 'a good answer');

    const after = await (await worker.fetch('/health')).json();
    assert.equal(after.health_metrics.consecutive_errors, 0);
  } finally {
    await worker.dispose();
  }
});

// ─── The typed path, driven directly ──────────────────────────────────────
//
// Everything above goes through the REPLAY path, because the mock extension
// speaks the streaming protocol and its STREAM_DONE branch carries a success
// writer of its own. That made the round trips above unable to fail when the
// single-exit write was deleted — verified by mutation, see the note at the
// bottom.
//
// The typed path is the one that matters. `requireGrounding` throws
// `replay_skipped_for_grounding` before the replay stream starts, so every
// grounding-required call — every `horo_consult` — takes it. It is also the
// path that had no success writer at all, which is the bug.
//
// So this block forces the typed path and stubs its two DOM collaborators.

async function forceTypedPath(worker, { text = 'a grounded answer with real citations', ok = true } = {}) {
  const b = worker.bridge;
  // executeThroughExtension gates on isExtensionReady() before it ever chooses
  // a path, so the typed path is unreachable without one. The mock extension
  // is needed for readiness only — runReplayAttempt is stubbed out right
  // after, so nothing on the replay path is ever reached.
  await connectFakeExtension(worker, { onExecute: () => ({ text: 'unused', delayMs: 0 }) });
  b.typePromptThroughUi = async () => ({ ok: true, reason: null, step: null, responsesBefore: 0 });
  b.collectTypedAnswer = async () => ({ ok, text, responses: 1, reason: ok ? null : 'no_answer_rendered' });
  b.runReplayAttempt = async () => {
    throw Object.assign(new Error('replay skipped'), { __typedOnly: true });
  };
  return b;
}

const typedCall = (worker) => worker.bridge.executeThroughExtension(
  [{ role: 'user', content: 'question' }], null, MODEL,
  { requireGrounding: true, requireTypedPath: true },
);

test('the typed path — the one horo_consult always takes — resets the counter', async () => {
  const worker = createMockWorker();
  try {
    await forceTypedPath(worker);
    worker.bridge.recordHealthError('transient failure 1');
    worker.bridge.recordHealthError('transient failure 2');
    worker.bridge.recordHealthError('transient failure 3');
    assert.equal(worker.bridge.healthState.consecutiveErrors, 3);

    const text = await typedCall(worker);

    assert.match(text, /grounded answer/, 'the typed answer must be returned');
    const health = worker.bridge.healthState;
    assert.equal(health.consecutiveErrors, 0,
      'a successful TYPED generation must clear the counter — this is the exact regression');
    assert.equal(health.lastError, null);
    assert.notEqual(health.lastSuccessfulGeneration, null);
  } finally {
    await worker.dispose();
  }
});

test('a failed typed path still raises the counter', async () => {
  const worker = createMockWorker();
  try {
    // The inverse. A fix that unconditionally called recordHealthSuccess()
    // would pass the test above and break this one — which is why both exist.
    await forceTypedPath(worker, { ok: false });
    await assert.rejects(() => typedCall(worker), /no new answer was rendered/);
    assert.equal(worker.bridge.healthState.consecutiveErrors, 1);
    assert.match(worker.bridge.healthState.lastError, /^collect_answer_failed:/);
  } finally {
    await worker.dispose();
  }
});
test('a typed refusal is an error, not a success', async () => {
  const worker = createMockWorker();
  try {
    await forceTypedPath(worker, { text: "I'm sorry, I can't help with that." });
    await typedCall(worker);
    const health = worker.bridge.healthState;
    assert.match(health.lastError ?? '', /^gemini_hard_refusal:/);
    assert.equal(health.consecutiveErrors, 1);
  } finally {
    await worker.dispose();
  }
});

test('an empty typed answer is an error, not a success', async () => {
  const worker = createMockWorker();
  try {
    // The typed path is where this bites hardest: an answer that never
    // rendered reads as an empty string, and classifyGeminiReply("") returns
    // ANSWERED because it is a text classifier matching refusal patterns.
    await forceTypedPath(worker, { text: '' });
    await typedCall(worker);
    const health = worker.bridge.healthState;
    assert.match(health.lastError ?? '', /^empty_answer:/);
    assert.equal(health.consecutiveErrors, 1);
    assert.equal(health.lastSuccessfulGeneration, null);
  } finally {
    await worker.dispose();
  }
});

// ─── Mutations ─────────────────────────────────────────────────────────────
//
// MUTATION HISTORY, recorded because it is the point of the file:
//
//   The FIRST version drove every assertion through POST /v1/chat/completions
//   against the mock extension. All five tests passed. Deleting the single-exit
//   success write ENTIRELY also passed all five — the mock answers over the
//   replay stream, whose STREAM_DONE branch carries a success writer, so a
//   round trip can never fail for a missing typed-path write.
//
//   A green suite that cannot fail is worse than no suite, because it reads as
//   coverage. The typed-path tests above exist because of that observation.
//
// MUTATION A — delete the single-exit recordHealthSuccess() (~index.js:1885).
//   Expect: "the typed path ... resets the counter" FAILS, and nothing else.
//
// MUTATION B — move the success write ABOVE the verdict check.
//   Expect: both refusal tests FAIL — the write clears the counter before the
//   classification can raise it.
//
// MUTATION C — remove the `else if (!text || !text.trim())` branch.
//   Expect: "an empty typed answer" FAILS, plus the round-trip empty test.
//
// MUTATION D — delete the STREAM_DONE success write (~index.js:2252).
//   Expect: NOTHING fails. Correct: the single exit now covers the replay path
//   too. Recorded so the redundancy is known rather than assumed.
