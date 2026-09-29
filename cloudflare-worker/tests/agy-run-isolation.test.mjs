/**
 * The delegation tooling's isolation gate, pinned.
 *
 * `agy-run --mode worktree` claims the caller's repo is untouched. On
 * 2026-09-29 that claim was false: a packet with a hardcoded
 * `cd /Users/me/Project/repo` in its verify section sent an isolated agy
 * delegate straight out of its worktree, it edited the caller's
 * checkout, and the script still printed "your repo is untouched". The
 * same run also left a mutation applied to the caller's source.
 *
 * Three properties make the claim checkable rather than asserted:
 *
 *   1. the repo is snapshotted BEFORE the agent runs, not only compared
 *      afterwards - without a "before", "after" alone cannot detect a
 *      change
 *   2. a breach exits 71, distinct from the agent's own rc and from the
 *      circuit breaker's 75, so a breach cannot be read as success
 *   3. `git status --porcelain`, not `git diff` - diff alone misses
 *      untracked files, which is how the new test file the agent created
 *      would have escaped notice
 *
 * Read as source, the technique build-stamp.test.mjs already uses for
 * scripts/build-extension.py. It cannot execute the script without
 * spawning a real agent, and pretending otherwise would be the same
 * class of mistake this project keeps making. What it does check is
 * real: that the snapshot precedes the run, that the exit code is
 * distinct, and that untracked files are included.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const SCRIPT = join(HOME, '.local', 'bin', 'agy-run');
const available = fs.existsSync(SCRIPT);
const skip = available ? false : `agy-run not found at ${SCRIPT}`;

const src = available ? fs.readFileSync(SCRIPT, 'utf8') : '';

/** Line number of the first line matching `re`, or -1. */
function lineOf(re) {
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return -1;
}

test('agy-run snapshots the caller repo before the agent runs', { skip }, () => {
  const snapshot = lineOf(/REPO_BEFORE=\$\(git -C "\$REPO_ROOT" status --porcelain/);
  assert.ok(snapshot > 0, 'the repo must be snapshotted, and the snapshot must use porcelain status');

  // The snapshot has to come before the agent is launched. Find the launch.
  const launch = Math.min(
    ...[lineOf(/exec \$agent --model/), lineOf(/exec \$agent --print-timeout/), lineOf(/\$agent exec "\$\{ARGS\[@\]\}"/)]
      .filter((n) => n > 0)
  );
  assert.ok(launch > 0, 'could not locate where the agent is launched');
  assert.ok(snapshot < launch,
    `the snapshot (line ${snapshot}) must precede the agent launch (line ${launch}); ` +
    'an "after"-only comparison cannot detect a change');
});

test('an isolation breach exits 71, distinct from success and from the breaker', { skip }, () => {
  const breach = src.match(/ISOLATION BREACH[\s\S]{0,900}?exit (\d+)/);
  assert.ok(breach, 'a breach must be reported and must exit non-zero');

  const code = Number(breach[1]);
  assert.equal(code, 71, 'the breach code must be its own value');
  assert.notEqual(code, 0, 'a breach is not success');
  assert.notEqual(code, 75, 'and must not collide with the all-dead circuit breaker');
});

test('the gate compares porcelain status, so untracked files count', { skip }, () => {
  // `git diff` sees only tracked files. The breach that motivated this
  // included a new test file, which diff would have missed entirely.
  const compare = src.match(/REPO_AFTER=\$\(git -C "\$REPO_ROOT" ([\w-]+)/);
  assert.ok(compare, 'the post-run comparison must be present');
  assert.equal(compare[1], 'status', 'git diff alone cannot see an untracked file');
  assert.ok(!/git -C "\$REPO_ROOT" diff\b/.test(src.split('REPO_AFTER')[1]?.slice(0, 200) || ''),
    'the post-run check must not rely on git diff');
});

test('the gate fires only on a real difference, not on every run', { skip }, () => {
  assert.match(src, /if \[ "\$REPO_AFTER" != "\$REPO_BEFORE" \]/,
    'the comparison must be a difference test, or it would either never fire or always fire');
});

test('the worktree path is injected so a packet cannot send the agent elsewhere', { skip }, () => {
  assert.match(src, /WT_PATH = \$WT_DIR/,
    'the agent must be told where it is by name');
  assert.match(src, /Do NOT/,
    'and told not to leave it - the breach was a packet overriding isolation, not the agent ignoring it');
  assert.match(src, /grep -qE '\(\^\|\[\[:space:\]\]\)cd\[\[:space:\]\]\+\/' "\$PACKET"/,
    'a packet containing an absolute cd must be flagged to the caller');
});
