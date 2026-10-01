// Guard: no GitHub Action pin may target the removed Node 20 runtime.
//
// (KAN-227)
//
// Why this exists is quoted from the ticket's own note, because it is
// the whole finding:
//
//   "The deprecation warning is currently the only signal. Nothing in
//   the repo asserts anything about action runtime versions, so a
//   future pin re-introducing @v4 would pass every test."
//
// The timeline makes it worse than a warning. Node 20 reached
// end-of-life Apr 2026, runners defaulted to Node 24 on Jun 16, and
// Node 20 was REMOVED from GitHub Actions on Sep 23 2026 - eight days
// before this was filed. Every pipeline was green only because GitHub
// was still routing these actions onto Node 24 through a forced
// fallback past a removal date. That is the state where everything
// works and nothing says why.
//
// The floors and their reasons live in helpers/action-pins.mjs, which
// documents why they were measured from action.yml rather than from
// release notes. The short version: upload-artifact@v5's notes
// announce Node 24 and its manifest says node20, so a bump that
// trusted the notes would have shipped a lie.
//
// Follows the shape of extension-version-line.test.mjs and
// cd-concurrency-audit.test.mjs: configuration regresses silently, so
// the invariant is written once and CI enforces it on every push.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

import {
  PIN_FLOORS,
  REPO_ROOT,
  scanActionPins,
  parseUsesPin,
  stripComment,
} from './helpers/action-pins.mjs';

const CI = fs.readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');

test('every action pin is at or above its measured floor (KAN-227)', () => {
  const report = scanActionPins();

  assert.ok(
    report.checked > 0,
    'the scan found no pins at all. A scanner that silently reads ' +
      'zero workflows reports success while checking nothing, which ' +
      'is how this ticket happened twice.'
  );

  assert.deepEqual(
    report.belowFloor,
    [],
    `pins below their floor:\n  ${report.belowFloor.join('\n  ')}`
  );
  assert.deepEqual(
    report.unparsed,
    [],
    `pins that cannot be checked against a floor:\n  ${report.unparsed.join('\n  ')}`
  );
  assert.deepEqual(report.node20, [], report.node20.join('\n  '));
  assert.equal(report.ok, true);
});

test('the upload-artifact floor is 6, not 5 (KAN-227)', () => {
  // This row exists because it is the trap. upload-artifact v5's
  // release notes read "**BREAKING CHANGE:** this update supports Node
  // v24.x"; its action.yml at that tag says `using: node20`. Anyone
  // who bumps by reading release notes stops one pin short of the
  // goal, on a removed runtime, with a changelog entry saying it was
  // done.
  const entry = PIN_FLOORS.find((f) => f.action === 'actions/upload-artifact');

  assert.ok(entry, 'the upload-artifact floor must be recorded');
  assert.equal(
    entry.floor,
    6,
    'upload-artifact v5 ships using: node20 despite announcing Node 24; ' +
      'v6 is the first tag that actually runs on node24'
  );
  assert.equal(entry.runtimeAtFloor, 'node24');
});

test('every recorded floor names a node24 tag (KAN-227)', () => {
  // A floor with no recorded runtime could be wrong in the direction
  // that matters: the floor would admit pins while saying nothing
  // about what runtime those pins actually use.
  for (const f of PIN_FLOORS) {
    assert.equal(
      f.runtimeAtFloor,
      'node24',
      `${f.action}@v${f.floor} is recorded as ${f.runtimeAtFloor}. ` +
        'Re-measure helpers/action-pins.mjs against action.yml at that tag ' +
        'before trusting any pin at or above this floor.'
    );
    assert.ok(f.reason && f.reason.length > 20, `${f.action} must record why its floor is where it is`);
  }
});

test('parseUsesPin classifies pins without guessing (KAN-227)', () => {
  const cases = [
    ['actions/checkout@v4', 4],
    ['actions/checkout@v7', 7],
    ['actions/checkout@v7.0.1', 7],
    ['actions/checkout@4', 4],
    ['actions/checkout@7.0.1', 7],
    ['actions/setup-python@v5', 5],
    ['gitleaks/gitleaks-action@v3.0.0', 3],
  ];
  for (const [ref, want] of cases) {
    const pin = parseUsesPin(ref);
    assert.ok(pin, `${ref} must parse as a pin`);
    assert.equal(pin.major, want, `${ref} major`);
  }

  for (const ref of ['./local/action', 'docker://alpine:3', '']) {
    assert.equal(parseUsesPin(ref), null, `${ref} is not an action pin`);
  }
});

test('a SHA or branch pin is unparseable, never a passing major (KAN-227)', () => {
  // This is the case a naive regex gets wrong, and getting it wrong
  // is the worst direction available: `@8f4b7f84...` parses as major 8,
  // sails past every floor, and the guard silently exempts the most
  // rigorous pin form there is - from a gate whose entire job is to
  // catch unpinned actions.
  const sha = parseUsesPin('actions/checkout@8f4b7f84864484a7bf31766abe9204da3cbe65b3');
  assert.ok(sha, 'a SHA ref is still an action pin');
  assert.equal(
    sha.major,
    null,
    'a 40-char hex SHA must not parse as a major version'
  );

  for (const ref of ['actions/checkout@main', 'actions/checkout@release-1', 'actions/checkout@2fa']) {
    assert.equal(
      parseUsesPin(ref).major,
      null,
      `${ref} must be unparseable rather than given a made-up major`
    );
  }
});

test('stripComment removes real comments and nothing else (KAN-227)', () => {
  assert.equal(stripComment('      - uses: actions/checkout@v7'), '      - uses: actions/checkout@v7');
  assert.equal(stripComment('  # closes the loop between the two systems'), '  ');
  assert.equal(stripComment('        runs-on: ubuntu-26.04 # pinned'), '        runs-on: ubuntu-26.04 ');
  // A `#` mid-token is not a comment. Truncating it would corrupt the
  // value rather than trimming a comment.
  assert.equal(stripComment('        run: echo "a#b"'), '        run: echo "a#b"');
});

test('security-scan still checks out with fetch-depth: 0 for gitleaks (KAN-227)', () => {
  // The premise the version bump rests on. ci.yml records why: gitleaks
  // needs full history to diff against its baseline, and a shallow
  // checkout makes the git wrapper fail with "stderr is not empty".
  //
  // Asserted because checkout v6 changes where creds are persisted, and
  // this job's failure mode is already documented as opaque - the
  // break would present as a secret-scan failure naming nothing.
  //
  // Scoped to the JOB BLOCK, deliberately. A proximity match across the
  // whole file is satisfied by the fetch-depth: 0 belonging to a
  // different job - ci.yml declares it three times - so a window-based
  // regex passes with the gitleaks checkout made shallow, which is
  // exactly the regression this test exists to catch.
  //
  // The lookahead is anchored at 2-space indent because that is where
  // job keys live (`  security-scan:`). An earlier version looked for a
  // column-0 key, which never occurs inside `jobs:` — the block then ran
  // to the end of the file, swallowed four unrelated fetch-depth lines,
  // and passed no matter what was deleted. Both the indent and the
  // mutation below are deliberate: this assertion is checked against a
  // real deletion of line 169, not reasoned about.
  const job = /\n {2}security-scan:\n(?:(?!\n {2}[a-zA-Z][a-zA-Z0-9_-]*:\n)[\s\S])*/.exec(CI);
  assert.ok(job, 'ci.yml must keep a security-scan job');

  // Guard the guard: a job block that swallowed the file would satisfy
  // any assertion below, which is how this test was briefly vacuous.
  assert.ok(
    job[0].length < 4000,
    `the security-scan block is ${job[0].length} chars — the job-boundary ` +
      'regex is over-matching and any assertion against it is vacuous'
  );

  assert.match(
    job[0],
    /uses:\s*actions\/checkout@v\d+[\s\S]*?fetch-depth:\s*0/,
    'the gitleaks job must check out with fetch-depth: 0 - a shallow ' +
      'checkout makes the gitleaks git wrapper fail with "stderr is not empty"'
  );

  // And the checkout must be the one that feeds gitleaks, not a later step.
  const checkoutIdx = job[0].indexOf('uses: actions/checkout');
  const gitleaksIdx = job[0].indexOf('uses: gitleaks/gitleaks-action');
  assert.ok(checkoutIdx !== -1 && gitleaksIdx !== -1, 'both steps must exist in this job');
  assert.ok(
    checkoutIdx < gitleaksIdx,
    'the checkout must precede the gitleaks step, or the full history is ' +
      'never available to the scan'
  );
});

test('the gitleaks step still passes its config through the environment (KAN-227)', () => {
  // v2 rejected a `config:` input at runtime with "Unexpected input(s)",
  // which meant the custom rules were silently never applied: the job
  // reported green while scanning with the DEFAULT ruleset, which has
  // no rule matching this repo's secret prefixes. A secret gate that
  // silently scans with the wrong ruleset is worse than no gate,
  // because it is trusted.
  //
  // v3's action.yml still declares no inputs at all, so the env-var
  // mechanism is the one that must survive the bump.
  const step = /uses: gitleaks\/gitleaks-action@v\d+[\s\S]*?(?=\n {6}- name:|\n {2}[a-z-]+:|$)/.exec(CI);
  assert.ok(step, 'must keep a gitleaks-action step');

  // Guard the guard: a window that swallowed the rest of the file would
  // satisfy every assertion below. The gitleaks step is short by design.
  assert.ok(
    step[0].length < 2000,
    `the gitleaks step window is ${step[0].length} chars — it has over-matched ` +
      'and the assertions below would pass on unrelated content'
  );

  assert.doesNotMatch(
    step[0],
    /^\s*with:/m,
    'gitleaks-action declares no inputs; a `with:` block is rejected at ' +
      'runtime and the custom ruleset is silently skipped'
  );
  assert.match(step[0], /GITLEAKS_CONFIG/, 'the custom ruleset must still be supplied via the environment');
  assert.match(step[0], /\.gitleaks\.toml/, 'and must still point at this repo\'s dot-prefixed config');
});