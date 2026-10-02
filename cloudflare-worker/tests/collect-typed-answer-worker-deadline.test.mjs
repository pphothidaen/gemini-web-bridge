/**
 * KAN-236, worker half: collectTypedAnswer's deadline was flat wall-clock while
 * the extension half had already been made idle-based.
 *
 * Two defects, both recorded as "known incomplete" in the 4.7.24 changelog:
 *
 *   1. The timer is a flat 120 s. Measured 2026-10-02 on three grounded calls,
 *      StreamGenerate ran 36151-38353 ms before the answer rendered, so the
 *      margin on a fast grounded answer is ~3.2x and on a slow one it is
 *      nothing. The caller is the half that actually gave up.
 *
 *   2. The timeout path reports `lastCollectedResponseCount`, which is only
 *      written when a COLLECT_ANSWER_RESULT arrives. On a timeout none has, so
 *      the message said `responses on screen=0` while the page held 5.
 *
 * Pinned from the outside, through the real DO method, with a fake socket and a
 * virtual clock. The mutations at the bottom are the real content — a test that
 * passes for both a sliding and a non-sliding deadline proves nothing about
 * which one is implemented.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE = fs.readFileSync(
  path.resolve(new URL('../src/index.js', import.meta.url).pathname),
  'utf8'
);

/** Pull collectTypedAnswer out of the class and run it against a fake `this`. */
function extractCollectTypedAnswer() {
  const start = SOURCE.indexOf('  collectTypedAnswer({');
  const end = SOURCE.indexOf('\n  /**', start);
  const body = SOURCE.slice(start, end).trim();
  const decl = body.indexOf('collectTypedAnswer(');
  const fnSrc = body.slice(decl).replace(/^collectTypedAnswer\(/, 'function (');
  // eslint-disable-next-line no-new-func
  return new Function(`return (${fnSrc})`)();
}

/**
 * A DO-shaped harness: the real method body, a fake socket that records what
 * went out, and a controllable clock.
 */
function harness({ timeoutMs = 30000 } = {}) {
  const sent = [];
  // Timers are held in a Map keyed by a monotonic id, not an array index.
  // An array index breaks the moment the queue is sorted, because a sort
  // permutes the entries while clearT is still holding the old position —
  // which silently fails to cancel the very timer the slide depends on.
  const timers = new Map();
  let nextTimerId = 1;
  let clock = 0;
  const self = {
    activeStreams: new Map(),
    pendingCollections: new Map(),
    lastCollectedResponseCount: 0,
    activeSocket: { send: (s) => sent.push(JSON.parse(s)) },
    pendingRequests: []
  };
  const api = extractCollectTypedAnswer();

  return {
    self,
    sent,
    run: (opts = {}) =>
      api.call(self, {
        requestId: 'req_t1',
        timeoutMs,
        now: () => clock,
        setT: (fn, ms) => {
          const id = nextTimerId++;
          timers.set(id, { fn, at: clock + (ms || 0) });
          return id;
        },
        clearT: (id) => { timers.delete(id); },
        ...opts
      }),
    /** Fire the activeStreams callback as if a message arrived from the wire. */
    deliver: (msg) => self.activeStreams.get('req_t1')?.(msg),
    /** Advance the clock, firing due timers in order. */
    async advance(toMs) {
      for (let guard = 0; guard < 200000; guard++) {
        let next = null;
        for (const [id, t] of timers) {
          if (t.at > toMs) continue;
          if (!next || t.at < next.t.at) next = { id, t };
        }
        if (!next) break;
        timers.delete(next.id);
        clock = next.t.at;
        next.t.fn();
        await Promise.resolve();
      }
      clock = toMs;
      await Promise.resolve();
    }
  };
}
test('the worker deadline slides while the page reports a live generation', async () => {
  // Heartbeats with generating:true every 3s of virtual time, up to the hard
  // cap. Under the old flat timer this resolved at 30000; it must not.
  const h = harness({ timeoutMs: 30000 });
  const pending = h.run();

  // advance() FIRST, then deliver — a heartbeat delivered before the clock
  // moves reports the same elapsed time every time, which is how the slide
  // test passes for the wrong reason.
  //
  // Stop at 60000: hardCap is max(30000*3, 30000+60000) = 90000, so past that
  // the slide is no longer supposed to hold. Asserting "still pending" at 90000
  // would contradict the hard-cap test two cases down.
  for (let t = 3000; t <= 60000; t += 3000) {
    await h.advance(t);
    h.deliver({ type: 'COLLECT_ANSWER_PROGRESS', generating: true, responses: 4 });
  }

  let settledEarly = false;
  pending.then(() => { settledEarly = true; });
  await h.advance(60000);
  await Promise.resolve();
  assert.equal(settledEarly, false,
    'a generation visibly in progress must not be cut off at the flat 30s budget');

  h.deliver({ type: 'COLLECT_ANSWER_RESULT', ok: true, text: 'the answer', responses: 5 });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.text, 'the answer');
  assert.equal(result.waitedMs, 60000,
    'waitedMs reports how long the page was actually given');
});

test('an idle page still times out on schedule, without heartbeats', async () => {
  // No progress messages at all. This is a dead page. An unbounded wait would
  // be a worse bug than the one being fixed.
  const h = harness({ timeoutMs: 30000 });
  const pending = h.run();
  await h.advance(31000);
  const settled = await pending;
  assert.equal(settled.ok, false);
  assert.equal(settled.reason, 'collect_answer_timeout');
});

test('a heartbeat reporting generating:false does not extend the deadline', async () => {
  // The slide must be conditional on real progress. A page that is present but
  // idle keeps its original budget — otherwise a hung page that emits
  // heartbeats would wait forever.
  const h = harness({ timeoutMs: 30000 });
  const pending = h.run();
  for (let t = 3000; t <= 28000; t += 3000) {
    await h.advance(t);
    h.deliver({ type: 'COLLECT_ANSWER_PROGRESS', generating: false, responses: 4 });
  }
  await h.advance(31000);
  const settled = await pending;
  assert.equal(settled.ok, false,
    'heartbeats that report no generation must not keep the call alive');
  assert.equal(settled.reason, 'collect_answer_timeout');
});

test('the timeout reports the page ACTUAL response count, not 0', async () => {
  // The defect: lastCollectedResponseCount is only written when a RESULT
  // arrives, so on a timeout it was always 0. The heartbeat keeps it live.
  //
  // This drives the deadline all the way to the hardCap with generating:true
  // throughout, so the timeout fires from a SLID deadline — the case where the
  // old code was guaranteed to print 0.
  const h = harness({ timeoutMs: 30000 });
  const pending = h.run();
  for (let t = 3000; t <= 100000; t += 3000) {
    await h.advance(t);
    h.deliver({ type: 'COLLECT_ANSWER_PROGRESS', generating: true, responses: 5 });
  }
  await h.advance(100000);
  const settled = await pending;
  assert.equal(settled.responses, 5,
    'the count the page reported must survive to the timeout message');
  assert.ok(settled.waitedMs > 30000,
    'and the timeout must report the longer time it actually waited');
});

test('the hard cap bounds a generation that never stops claiming progress', async () => {
  // The failure mode an unbounded slide would produce: a page that reports
  // generating forever. hardCap is max(timeout*3, timeout+60000) = 90000 here.
  const h = harness({ timeoutMs: 30000 });
  const pending = h.run();
  for (let t = 3000; t <= 200000; t += 3000) {
    await h.advance(t);
    h.deliver({ type: 'COLLECT_ANSWER_PROGRESS', generating: true, responses: 4 });
  }
  await h.advance(200000);
  const settled = await pending;
  assert.equal(settled.ok, false, 'a page stuck generating forever must still fail');
  assert.equal(settled.reason, 'collect_answer_timeout');
});

test('a settled collection leaves no live timer behind', async () => {
  const h = harness({ timeoutMs: 30000 });
  const pending = h.run();
  h.deliver({ type: 'COLLECT_ANSWER_RESULT', ok: true, text: 'done', responses: 1 });
  await pending;
  assert.equal(h.self.pendingCollections.size, 0,
    'pendingCollections must be cleaned up on settle');
  assert.equal(h.self.activeStreams.size, 0,
    'activeStreams must be cleaned up on settle');
  // If a timer had survived it would fire into the already-resolved path.
  await h.advance(120000);
  assert.equal(h.self.pendingCollections.size, 0);
});

// MUTATIONS — the real content. Each asserts the source contains the specific
// mechanism, so a refactor that silently removes the behaviour fails here.
test('MUTATION: the slide must be anchored to a fixed origin, not compounded', () => {
  // The compound form (`deadline = timeoutMs + elapsed`, re-armed from the
  // current clock) grew the wait geometrically and never settled. Pinning the
  // shape of the correct expression is what stops it coming back.
  assert.match(SOURCE, /fireAt = Math\.min\(startedAt \+ timeoutMs \+ elapsed, startedAt \+ hardCap\)/);
  assert.match(SOURCE, /\}, fireAt - now\(\)\);/,
    'the timer must be armed relative to the current clock, not an absolute deadline');
});

test('MUTATION: the heartbeat must update the count the timeout path reads', () => {
  assert.match(
    SOURCE,
    /COLLECT_ANSWER_PROGRESS[\s\S]{0,300}lastCollectedResponseCount = Number\(msg\.responses\)/
  );
});

test('MUTATION: the slide must be bounded or a stuck page waits forever', () => {
  assert.match(SOURCE, /hardCap = Math\.max\(timeoutMs \* 3, timeoutMs \+ 60000\)/);
});

test('the heartbeat announces itself exactly once per collection', () => {
  // Without this the heartbeat is unobservable: after an extension reload there
  // is no way to tell the new build from the old one, because the worker's
  // slide stays invisible whenever a generation finishes inside the flat budget
  // — which is every healthy run. One console line per collection is what makes
  // "is the 4.7.25 half actually loaded?" answerable.
  const CONTENT = fs.readFileSync(
    path.resolve(new URL('../../extension-cloudflare/content.js', import.meta.url).pathname),
    'utf8'
  );
  assert.match(CONTENT, /COLLECT_ANSWER_PROGRESS active/,
    'the first heartbeat must log, or the extension half cannot be verified live');
  // Once, not per beat: a 3s interval that logged every tick would flood the
  // console during a long generation.
  assert.match(CONTENT, /if \(!announced\) \{\s*announced = true;/,
    'the announcement must be latched so it fires exactly once');
});