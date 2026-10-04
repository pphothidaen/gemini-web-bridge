/**
 * KAN-202 — the routing decision that decides whether an answer is complete.
 *
 * Four consecutive `orchestrate_sdlc_plan` calls over production returned
 * 442, 4,227, 4,892 and 6,735 characters; three of the four ended
 * mid-sentence or mid-table. The decisive observation was that the DOM
 * response measured 26px while the MCP caller received 6,735 characters —
 * the two are not the same text, because the replay path is a separate
 * request from the one the page renders.
 *
 * And `check_bridge_health` read `healthy` with `consecutive_errors: 0`
 * through all of it. A run that worked and was quietly wrong had nowhere to
 * report itself.
 *
 * Two things are pinned here:
 *
 *   1. every MCP tool routes through the typed path, not just the grounded
 *      one — `requireGrounding: true` alone would have exempted the four
 *      ungrounded tools, which are the ones that truncate
 *   2. a replay stream that dropped updates records a signal rather than
 *      passing as a clean success
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE = fs.readFileSync(
  path.resolve(new URL('../src/index.js', import.meta.url).pathname),
  'utf8'
);

/** All executeThroughExtension call sites that serve horo_consult. There are
 *  two since the KAN-204 stage pipeline: the single-call MCP handler and the
 *  per-stage pipeline runner. Both must force the typed path. */
function typedPathCallSites() {
  const sites = [];
  let from = 0;
  while (true) {
    const at = SOURCE.indexOf('requireTypedPath: true', from);
    if (at < 0) break;
    const start = SOURCE.lastIndexOf('executeThroughExtension(', at);
    const end = SOURCE.indexOf(');', at);
    sites.push(SOURCE.slice(start, end));
    from = end;
  }
  assert.ok(sites.length >= 2, 'the MCP handler and the stage pipeline call sites must both exist');
  return sites;
}

test('every MCP SDLC tool goes through the typed path, not just the grounded one', () => {
  for (const call of typedPathCallSites()) {
    assert.match(call, /requireTypedPath:\s*true/,
      'requireTypedPath must be unconditional here: the four ungrounded tools are ' +
      'the ones that truncate, so requireGrounding alone would not cover them');
  }
  const handlerCall = typedPathCallSites().find((call) => /Boolean\(notebookGrounding\)/.test(call));
  assert.ok(handlerCall, 'the single-call handler site must exist');
  assert.match(handlerCall, /requireGrounding:\s*Boolean\(notebookGrounding\)/,
    'the grounding requirement is unchanged and still expressed for what it is');
  const pipelineCall = typedPathCallSites().find((call) => /Boolean\(wantsNotebookAttach\)/.test(call));
  assert.ok(pipelineCall, 'the stage pipeline call site must exist');
  assert.match(pipelineCall, /requireGrounding:\s*Boolean\(wantsNotebookAttach\)/,
    'the stage pipeline grounds every stage off the same attach decision, not a flag that could drift');
});

test('useTypedOnly honours BOTH reasons', () => {
  assert.match(SOURCE, /const useTypedOnly = requireGrounding \|\| requireTypedPath;/,
    'a complete-answer requirement must route exactly like a grounding one');
});

test('a dropped replay update is recorded as a signal, not silently as success', () => {
  // The counter has to exist, be incremented on the reject path, and be
  // reported at STREAM_DONE. A counter nobody reads is decoration.
  assert.match(SOURCE, /let droppedUpdates = 0;/);
  assert.match(SOURCE, /droppedUpdates \+= 1;/,
    'the reject path in adoptText must count');
  assert.match(SOURCE, /if \(droppedUpdates > 0\)[\s\S]{0,200}recordHealthSignal\(/,
    'STREAM_DONE must surface the count');
  assert.match(SOURCE, /replay_dropped_updates:/,
    'and the signal must name the condition, so it is greppable later');
});

test('a signal is not an error: it must not touch the error counters', () => {
  const body = SOURCE.slice(
    SOURCE.indexOf('recordHealthSignal(message)'),
    SOURCE.indexOf('recordHealthSignal(message)') + 400
  );
  assert.ok(!/_consecutiveErrors/.test(body),
    'a signal must not increment the error counter — it is not a failure');
  assert.ok(!/_lastError\s*=/.test(body),
    'and must not overwrite last_error, or it would erase a real one');
  assert.match(body, /_lastSignal\s*=/);
});

test('the signal is surfaced by check_bridge_health, not written to nowhere', () => {
  assert.match(SOURCE, /lastSignal:\s*this\._lastSignal \|\| null,/,
    'healthState must carry it');
  assert.match(SOURCE, /last_signal:\s*this\.healthState\.lastSignal,/,
    'and check_bridge_health must report it — otherwise it is written and never read');
});

test('replay remains reachable for the OpenAI-compatible endpoints', () => {
  // The fix must not become "delete replay". Those endpoints have no typed
  // equivalent wired, and the signal now tells an operator when their answer
  // is suspect.
  const replaySends = (SOURCE.match(/type:\s*"EXECUTE_REQUEST"/g) || []).length;
  assert.ok(replaySends >= 1, 'runReplayAttempt must still send EXECUTE_REQUEST');
});
