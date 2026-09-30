/**
 * The build must not be able to go quietly stale.
 *
 * On 2026-09-29 a live verification was run against a build whose manifest
 * already said 4.7.10 while the JavaScript beside it predated the fix being
 * tested. The version looked current, so nobody asked whether the code was,
 * and the results were meaningless. Three similar incidents followed from
 * the same shape: an artifact exists, it looks authoritative, and it is not.
 *
 * Two things prevent a recurrence:
 *
 *  1. One build root. dist/extension (unpacked, what Chrome loads) and the
 *     packaged zip sit together under dist/. There is no second copy that can
 *     drift, and the old repo-root release/ is gone.
 *
 *  2. A stamp. dist/extension/BUILD.json records the version, the commit, and
 *     a digest of the source files that feed the build. `build-extension.py
 *     --verify` compares the stamp against the tree and exits non-zero on a
 *     mismatch.
 *
 * These tests pin the mechanism. They read the script as source rather than
 * executing it, so a test run never builds, injects secrets, or needs a
 * network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(
  new URL('../..', import.meta.url).pathname
);
const buildScript = fs.readFileSync(
  path.join(REPO, 'scripts/build-extension.py'),
  'utf8'
);
const gitignore = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8');

/** Source text of verify_build(), so tests can inspect its decisions. */
function verifyBody() {
  const start = buildScript.indexOf('def verify_build(');
  assert.ok(start > -1, 'build-extension.py must define verify_build()');
  const end = buildScript.indexOf('\ndef ', start + 1);
  return buildScript.slice(start, end > -1 ? end : start + 3000);
}

test('every build artifact lives under one root', () => {
  // Two output roots is how the two copies drifted apart in the first place.
  // The literals moved into extension.config.json so the path has ONE
  // definition shared with zip-extension.py. What is asserted here is the
  // invariant, not the expression that happens to encode it:
  //   - the unpacked build is dist/extension
  //   - it is derived from the configured relative path, not hardcoded
  //   - the packaged zip lives under dist/, not in a sibling release/
  const cfg = JSON.parse(
    fs.readFileSync(path.join(REPO, 'extension.config.json'), 'utf8'),
  ).extension;

  assert.equal(cfg.unpacked, 'dist/extension', 'unpacked build must be dist/extension');
  assert.match(
    buildScript,
    /DIST_DIR\s*=\s*REPO_ROOT\s*\/\s*_EXTENSION_CFG\["unpacked"\]\.rsplit/,
    'DIST_DIR must derive from the configured path, not a hardcoded literal',
  );
  assert.match(
    buildScript,
    /DEFAULT_OUT_DIR\s*=\s*REPO_ROOT\s*\/\s*_EXTENSION_CFG\["unpacked"\]/,
    'DEFAULT_OUT_DIR must be the configured unpacked path',
  );
  assert.match(
    buildScript,
    /RELEASE_DIR\s*=\s*DIST_DIR\s*$/m,
    'the packaged zip must live under dist/, not in a sibling release/'
  );
});

test('the build writes a stamp describing what it was made from', () => {
  for (const field of ['version', 'source_digest', 'commit', 'built_at']) {
    assert.match(
      buildScript,
      new RegExp(`"${field}"`),
      `BUILD.json must record ${field}`
    );
  }
});

test('staleness is detected by content, not by commit', () => {
  // The decisive detail. A commit SHA cannot see an uncommitted edit, and
  // the tree is dirty most of the time during development — so a
  // commit-only check reports "current" for a build that is days behind the
  // working tree. That is exactly the failure that hid a live verification.
  assert.match(buildScript, /def _source_digest\(\)/);
  assert.match(buildScript, /hashlib/);
  assert.match(
    buildScript,
    /built_digest\s*!=\s*src_digest/,
    'verify must compare the source digest, not only the commit'
  );
});

test('the digest covers every file that feeds the build', () => {
  // Hashing manifest.json alone would miss an edit to content.js, which is
  // the file that actually broke.
  const fn = /def _source_digest\(\)[\s\S]*?\n    return h\.hexdigest/.exec(buildScript);
  assert.ok(fn, '_source_digest must exist');
  assert.match(fn[0], /SRC_DIR\.rglob/);
});

test('--verify is read-only and exits non-zero when stale', () => {
  assert.match(buildScript, /"--verify"/);
  assert.match(buildScript, /if args\.verify:\s*\n\s*sys\.exit\(verify_build\(\)\)/);
  assert.match(buildScript, /return 1/);
});

test('the zip is produced by default, so it cannot fall behind', () => {
  // It used to require --create-zip, which is why release/ was still holding
  // v4.4.3 while the extension was at 4.7.11.
  assert.match(buildScript, /"--create-zip"[^\n]*default=True/);
  assert.match(buildScript, /"--no-zip"/);
});

test('dist/ is ignored exactly once', () => {
  // It appeared twice in .gitignore; harmless, but it hides edits to the
  // ignore rules when you go looking for why something is untracked.
  const distRules = gitignore
    .split('\n')
    .filter((l) => l.trim() === 'dist/');
  assert.equal(distRules.length, 1, 'dist/ should appear once in .gitignore');
  assert.ok(
    gitignore.split('\n').includes('dist/'),
    'dist/ must still be ignored — it holds a build with secrets injected'
  );
});

test('the removed release/ path is no longer ignored or referenced', () => {
  const rules = gitignore.split('\n').map((l) => l.trim());
  assert.ok(
    !rules.includes('release/'),
    'release/ is gone; ignoring it would hide its accidental return'
  );
  assert.doesNotMatch(
    buildScript,
    /REPO_ROOT\s*\/\s*["']release["']/,
    'nothing should still write to the old repo-root release/'
  );
});

test('clean removes every packaged artifact, not just the current version', () => {
  // A stale zip sitting next to a fresh one is the artifact most likely to be
  // loaded by mistake, so it is the one that must not survive a clean.
  const start = buildScript.indexOf('def clean(output_dir');
  assert.ok(start > -1, 'clean() must exist');
  const fn = buildScript.slice(start, start + 900);
  assert.match(fn, /glob\("extension-\*\.zip\*"\)/);
});

test('a moved HEAD alone is not staleness', () => {
  // First version compared commit SHAs and reported STALE whenever HEAD moved.
  // That was wrong: a commit touching docs, tests, or the worker does not
  // change what Chrome loads, so the build was still current. A check that
  // cries wolf on every doc commit is a check people learn to ignore — which
  // is how the real STALE gets missed.
  const body = verifyBody();
  assert.doesNotMatch(
    body,
    /problems\.append\(\s*f?"commit:/,
    'a commit difference must not be added to problems'
  );
  assert.match(body, /problems\.append\(\s*f?"version:/);
  assert.match(body, /problems\.append\(\s*f?"source changed:/);
});

test('the digest, not the commit, is what fails the check', () => {
  // Only version and source content may hard-fail.
  const hard = [...verifyBody().matchAll(/problems\.append\(\s*f?"([^:"]+):/g)]
    .map((m) => m[1]);
  assert.ok(hard.length > 0, 'there must be hard failure reasons');
  for (const reason of hard) {
    assert.ok(
      ['version', 'source changed'].includes(reason),
      `unexpected hard-failure reason: ${reason}`
    );
  }
});

test('the stamp is written before the build is reported as complete', () => {
  // If the stamp were written after the "✅ built" line, a crash in between
  // would leave a build that looks finished and cannot be verified.
  const stampCall = buildScript.indexOf('write_build_stamp(output_dir, version)');
  const successLine = buildScript.indexOf('✅ Extension built to:');
  assert.ok(stampCall > -1, 'the build must write a stamp');
  assert.ok(
    successLine > -1 && successLine < stampCall,
    'the stamp must be written as part of the build, and reported as such'
  );
});
