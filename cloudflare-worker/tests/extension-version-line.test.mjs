// Version-line invariant (KAN-224).
//
// Every release from 4.7.0 to 4.7.21 shipped without a git tag. ci.yml's
// "Determine version" step has two schemes:
//
//   Scheme 1 — an exact tag on this commit wins.
//   Scheme 2 — otherwise derive MAJ.MIN.PAT from the newest v[0-9]* tag,
//              and append github.run_number as a 4th component.
//
// With v4.4.3 as the newest tag, Scheme 2 produced `4.4.3.<run>` for a month.
// The worker was on 4.7.21 the whole time.
//
// Why it stayed invisible, which is the part worth encoding:
//
//   - `4.4.3.116` reads like a deliberate pre-release scheme, not an error.
//   - The build stamp (`dist/extension/BUILD.json`) agreed with the manifest
//     and said 4.7.21, while CI named the artifact 4.4.3.x. Two authorities,
//     each internally consistent, disagreeing — so build-stamp.test.mjs's
//     `--verify` check passed and could not have caught it.
//   - Nothing asserted that a release ever gets tagged.
//
// So these tests pin the base, and pin the guard that makes the next forgotten
// release line red in CI instead of shipping a misleading label.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const REPO = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const CI = fs.readFileSync(`${REPO}/.github/workflows/ci.yml`, 'utf8');

const git = (...args) =>
  execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();

const manifestVersion = () =>
  JSON.parse(fs.readFileSync(`${REPO}/cloudflare-worker/package.json`, 'utf8')).version;

/** Release tags visible to this checkout, newest first. */
function versionTags() {
  const tags = git('tag', '-l', 'v[0-9]*', '--sort=-v:refname')
    .split('\n')
    .filter(Boolean);
  // Fail here, loudly and specifically, rather than letting an empty list turn
  // into a TypeError three assertions later. An absent tag set is a real and
  // diagnosable condition — a shallow checkout — and the message has to say so,
  // because the symptom otherwise looks like a version mismatch.
  assert.ok(
    tags.length > 0,
    'no v[0-9]* tags are visible to this checkout. ci.yml Scheme 2 derives the ' +
      'build version from the newest tag, so a checkout without tags cannot ' +
      'validate the version line — it can only produce a false result. ' +
      'The Unit Tests job must check out with fetch-depth: 0.'
  );
  return tags;
}

const majorMinorPatch = (v) => v.split('.').slice(0, 3).join('.');

test('the newest release tag matches the committed worker version', () => {
  const tags = versionTags();

  const newest = majorMinorPatch(tags[0].replace(/^v/, ''));
  const declared = manifestVersion();

  // This is the assertion that was missing. Scheme 2 reads the tag base and
  // nothing compared it to the manifest, so a month of releases drifted past a
  // tag that was never moved.
  assert.equal(
    newest,
    majorMinorPatch(declared),
    `newest tag is ${tags[0]} (base ${newest}) but cloudflare-worker/package.json ` +
      `declares ${declared}. CI Scheme 2 builds MAJ.MIN.PAT from the tag, so every ` +
      `artifact would be published as ${newest}.<run> — a ${declared} codebase ` +
      `under a ${newest} label. Tag the release commit: ` +
      `git tag -a v${declared} <sha> -m 'Release ${declared}'`
  );
});

test('the version tag points at the commit that declares that version', () => {
  // A tag is only a release record if it sits on the commit carrying the
  // version. A tag moved onto an unrelated later commit would satisfy the test
  // above while pointing bisect at the wrong tree.
  for (const tag of versionTags()) {
    const version = tag.replace(/^v/, '');
    const atTag = JSON.parse(
      execFileSync('git', ['show', `${tag}:cloudflare-worker/package.json`], {
        cwd: REPO,
        encoding: 'utf8',
      })
    ).version;

    assert.equal(
      majorMinorPatch(atTag),
      majorMinorPatch(version),
      `${tag} points at a commit whose package.json says ${atTag} — a release tag ` +
        'must sit on the commit that declares the version it names'
    );
  }
});

test('ci.yml fails closed when the tag base is behind the manifest', () => {
  // The guard is the part that survives the next forgotten release. Tagging
  // v4.7.21 fixed today; nothing stopped the same thing happening on 4.7.22.
  assert.match(
    CI,
    /Version base is stale/,
    'ci.yml must detect a tag base behind the committed version'
  );
  assert.match(
    CI,
    /read_manifest_version\s*\)\s*\n\s*#.*\n(?:.*\n)*?\s*if \[ "\$LOWEST" != "\$BASE3" \]/,
    'the comparison must actually read the committed manifest and branch on it'
  );
  // Fail-closed, per the repo governance rule: a gate that cannot read its
  // oracle must not be read as "passed". Silently building a mislabelled
  // artifact is the failure this whole ticket exists to stop.
  const staleBlock = /if \[ "\$LOWEST" != "\$BASE3" \]; then([\s\S]*?)fi/.exec(CI);
  assert.ok(staleBlock, 'the stale-base branch must exist');
  assert.match(
    staleBlock[1],
    /exit 1/,
    'a stale version base must fail the step, not warn — a warning is invisible in ' +
      'a green run, which is exactly how a month of mislabelled builds shipped'
  );
});

test('the guard compares on three components, not four', () => {
  // BASE may carry a 4th build counter from a tag that does; comparing the
  // full string would make 4.7.21 look "behind" 4.7.21.0 and fail forever.
  assert.match(CI, /BASE3="\$MAJ\.\$MIN\.\$PAT"/, 'the comparison base must be reduced to MAJ.MIN.PAT');
});

// ── Executed guard, not just a source read ────────────────────────────
//
// Reading ci.yml as text proves the guard is written down. It does not prove
// the shell arithmetic is right — `sort -V` ordering, empty input, and the
// ">= vs >" distinction between the hard failure and the warning are all easy
// to get subtly wrong and impossible to see in a grep. These run the real
// expression from the real workflow against real version pairs.

/** Pulls the real `LOWEST=$(...)` line out of the workflow and runs it. */
function lowestOf(a, b) {
  // Located by content, not by a regex over its escaping. A pattern that has to
  // reproduce every backslash in the YAML is a test that breaks on a harmless
  // reformat, and the failure looks like a broken guard rather than a broken
  // matcher.
  const line = CI.split('\n').find((l) => l.trim().startsWith('LOWEST=$('));
  assert.ok(line, 'ci.yml must compute LOWEST from BASE3 and MANIFEST');
  const expr = line.trim();
  return execFileSync('bash', ['-c', `${expr}; printf '%s' "$LOWEST"`], {
    encoding: 'utf8',
    env: { ...process.env, BASE3: a, MANIFEST: b },
  });
}

test('executed guard: the real sort expression ranks versions correctly', () => {
  // The stale case: base behind manifest -> BASE3 is the lowest, so the guard
  // fires. This is exactly the 4.4.3-base / 4.7.21-manifest situation.
  assert.equal(lowestOf('4.4.3', '4.7.21'), '4.4.3', 'a stale base must sort lowest');
  assert.notEqual(lowestOf('4.4.3', '4.7.21'), '4.7.21');

  // Equal: the ordinary case on every tagged release. Not stale.
  assert.equal(lowestOf('4.7.21', '4.7.21'), '4.7.21');

  // Numeric, not lexicographic. Lexicographic would make '4.9.0' < '4.10.0'
  // and wrongly fire on a legitimate 4.10 release.
  assert.equal(lowestOf('4.9.0', '4.10.0'), '4.9.0');
  assert.equal(lowestOf('4.10.0', '4.9.0'), '4.9.0');

  // A major bump: 4.x -> 5.x must still read as stale.
  assert.equal(lowestOf('4.7.21', '5.0.0'), '4.7.21');
});

test('executed guard: the live repo passes its own guard', () => {
  const tags = versionTags();
  const base = majorMinorPatch(tags[0].replace(/^v/, ''));
  const declared = manifestVersion();

  assert.equal(
    lowestOf(base, declared),
    base,
    `running the guard against this repo would fail it: base ${base}, declared ${declared}`
  );
});
