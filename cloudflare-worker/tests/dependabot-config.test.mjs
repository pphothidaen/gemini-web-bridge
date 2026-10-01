// Guard: Dependabot must keep watching the Actions workflows.
//
// (KAN-229)
//
// KAN-227 added action-runtime-pins.test.mjs, which pins a FLOOR. It
// catches a pin going backwards — an edit re-introducing @v4. It cannot
// catch a pin going FORWARDS. When actions/checkout@v8 ships, the floor
// test stays green, the Node 20 deprecation banner does not come back,
// and the repo is again N majors behind with nothing announcing it.
//
// That is KAN-227's own failure mode with the opposite sign, and the
// more likely one: upstream ships majors roughly quarterly, and this repo
// is on majors published in July 2026.
//
// Why this file needed its own test, not just a config. The two
// mechanisms are complements and both are load-bearing:
//
//   dependabot.yml  tells you a new major EXISTS
//   KAN-227          tells you a pin is too OLD once you decide to move
//
// Either can be deleted alone and the other still looks complete. That is
// how a guard becomes decorative, so deleting this one has to be red.
//
// KAN-227 was found by reading a deploy log. The Node 20 warning had been
// in every run of every workflow for six months. The signal existed;
// nothing was listening. This is the thing that listens.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, PIN_FLOORS } from './helpers/action-pins.mjs';

const CONFIG = join(REPO_ROOT, '.github/dependabot.yml');

/**
 * Minimal YAML reader for this one file.
 *
 * Deliberately not a YAML parser. The repo has no YAML dependency, CI job
 * 0 runs before `npm ci`, and validate-workflows.py is line-oriented for
 * exactly this reason. This reads the handful of keys the guard asserts
 * and nothing more; it is not a general parser and does not pretend to be.
 */
function readConfig() {
  assert.ok(
    fs.existsSync(CONFIG),
    '.github/dependabot.yml must exist — without it, an upstream major is ' +
      'announced only by a deprecation line in a log nobody opens. That is ' +
      'how 23 pins sat on the removed Node 20 runtime for six months (KAN-227).'
  );

  const raw = fs.readFileSync(CONFIG, 'utf8');

  // Strip comments before reading values, or a commented-out key reads as
  // a live one.
  const lines = raw
    .split('\n')
    .map((l) => {
      const h = l.indexOf('#');
      if (h === -1) return l;
      const before = l.slice(0, h);
      return before.trim() === '' || /\s$/.test(before) ? before : l;
    });

  const text = lines.join('\n');

  // Anchored to a full line, tolerating a leading YAML list dash so that
  // `- package-ecosystem: "github-actions"` resolves. Two bugs lived here
  // and both surfaced as a null value on a config that was in fact correct:
  //
  //   - the value class originally contained a stray newline, so it
  //     matched nothing at all;
  //   - a whitespace-only prefix cannot reach a key that follows "- ",
  //     which is exactly how `package-ecosystem` is written inside the
  //     `updates` list.
  //
  // A reader that returns null for the very key it exists to check is
  // worse than no reader: the failure looks like a config problem, so it
  // sends the next person to edit a file that was correct all along.
  const val = (key) => {
    const esc = key.replace(/[.*+?^$()|[\]{}]/g, '\\$&');
    const m = new RegExp(
      '^\\s*-?\\s*"?' + esc + '"?\\s*:\\s*"?([^"\\n#]+?)"?\\s*$',
      'm'
    ).exec(text);
    return m ? m[1].trim() : null;
  };

  // Guard the guard: fail HERE, loudly, if nothing at all is readable.
  // Otherwise every assertion below fails as `null` and the natural
  // reaction is to edit dependabot.yml, which was correct the whole time.
  assert.ok(
    val('package-ecosystem') !== null || val('directory') !== null,
    'dependabot-config.test.mjs could not read any key out of ' +
      'dependabot.yml — the TEST READER is broken, not the config. Do not ' +
      'change dependabot.yml in response to this failure.'
  );

  // Tab is illegal in YAML and its presence makes GitHub reject the file.
  assert.ok(!raw.includes('\t'), 'dependabot.yml must not contain a TAB character');

  return { raw, text, val };
}

test('dependabot.yml exists and targets the github-actions ecosystem (KAN-229)', () => {
  const { raw, val } = readConfig();

  assert.match(raw, /^version:\s*2\s*$/m, 'dependabot.yml must declare version: 2');
  assert.equal(
    val('package-ecosystem'),
    'github-actions',
    'the ecosystem must be github-actions — anything else leaves the action ' +
      'pins unwatched, which is the gap this file exists to close'
  );
});

test('dependabot watches the repository root (KAN-229)', () => {
  // Workflows live at .github/workflows/*.yml. There is no per-directory
  // config for this ecosystem, so "/" is the only value that finds them.
  // A wrong directory parses fine and silently watches nothing.
  const { val } = readConfig();
  assert.equal(
    val('directory'),
    '/',
    'directory must be "/" — a wrong value parses cleanly and silently ' +
      'monitors no workflows, which is indistinguishable from no config'
  );
});

test('dependabot runs on a schedule (KAN-229)', () => {
  const { text, val } = readConfig();

  assert.match(
    text,
    /schedule:\s*\n\s+interval:\s*"?(daily|weekly)"/,
    'an unscheduled Dependabot config never runs'
  );

  // Weekly is the deliberate choice and this asserts it, so changing it is
  // a decision that has to be made rather than an edit that slips through.
  // Daily against five workflows that upstream releases quarterly is a
  // stream that is empty almost every week — and a stream that is usually
  // empty is one whose signal gets dismissed, which is the failure this
  // file exists to fix, one level up.
  assert.equal(
    val('interval'),
    'weekly',
    'weekly keeps a major within the month without the daily noise that ' +
      'trains the reader to dismiss the one message that matters'
  );
});

test('dependabot does not ignore major updates (KAN-229)', () => {
  // The single most important assertion in this file.
  //
  // Ignoring majors for these actions would recreate precisely the blind
  // spot being closed: the repo would sit on a deprecated runtime with an
  // automated, documented reason never to look. action-runtime-pins
  // already encodes "too old" as a floor that fails the build — stating it
  // again as an ignore rule would be one fact in two places, free to
  // disagree.
  const { text } = readConfig();

  const ignoreBlocks = text.match(/^\s*ignore:\s*$/gm) || [];
  assert.deepEqual(
    ignoreBlocks,
    [],
    'no `ignore:` block — ignoring major updates for these actions would ' +
      'guarantee the repo never learns a new one exists, which is the ' +
      'KAN-227 failure automated'
  );

  assert.doesNotMatch(
    text,
    /update-types:\s*\[?\s*["']?version-update:\s*["']?false/,
    'version-update:false ignores new versions entirely and is never the ' +
      'right setting for an action runtime floor'
  );
});

test('dependabot groups each action into one pull request (KAN-229)', () => {
  // actions/checkout appears 12 times across the five workflows. Ungrouped,
  // one upstream major opens 12 PRs — 12 reviews, and 12 chances to merge
  // eight of them and leave the repo in a state nobody intended.
  const { text } = readConfig();

  assert.match(text, /^\s*groups:\s*$/m, 'per-action groups must be declared');

  for (const floor of PIN_FLOORS) {
    const name = floor.action.split('/')[1];
    assert.ok(
      new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:?\\s*$`, 'm').test(text) ||
        text.includes(floor.action),
      `dependabot must group ${floor.action} — every action carrying a KAN-227 ` +
        'floor needs a group, or one upstream major opens N separate PRs'
    );
  }
});

test('the pull request limit can hold every action open at once (KAN-229)', () => {
  // The default is 5. Against 5 distinct actions each able to produce a
  // major PR independently, a burst starts auto-closing the oldest —
  // including one a human was halfway through reviewing.
  const { text } = readConfig();

  const limit = Number(/open-pull-requests-limit:\s*(\d+)/.exec(text)?.[1]);
  assert.ok(Number.isInteger(limit), 'open-pull-requests-limit must be set explicitly');

  assert.ok(
    limit >= PIN_FLOORS.length + 5,
    `open-pull-requests-limit is ${limit} but there are ${PIN_FLOORS.length} ` +
      'actions with a floor; a burst of majors would auto-close the oldest ' +
      'open PR, including one mid-review'
  );
});

test('the config and the KAN-227 floor guard cover opposite directions (KAN-229)', () => {
  // If this file disappears, KAN-227's floor test still passes — it only
  // knows about majors that already exist. If the floor test disappears,
  // this file still opens PRs nobody evaluates. Neither is redundant with
  // the other, which is why both exist.
  // REPO_ROOT is the repository root, so the floor guard lives under
  // cloudflare-worker/tests — not tests/. Getting that path wrong is
  // exactly what this assertion checks, so it has to resolve correctly
  // itself.
  const floorTest = join(REPO_ROOT, 'cloudflare-worker/tests/action-runtime-pins.test.mjs');

  assert.ok(
    fs.existsSync(floorTest),
    'action-runtime-pins.test.mjs must exist — dependabot.yml surfaces new ' +
      'majors but does not evaluate whether a pin is too old; that is the ' +
      'floor guard, and it is not covered by this file'
  );
});