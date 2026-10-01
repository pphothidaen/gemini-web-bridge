// Functional tests for .githooks/pre-push (the Jira Guard, KAN-163).
//
// COMMIT_TICKET_MAPPING.md documents the predicted-key failure mode: the
// commit-msg hook only validates the KAN-<id> SHAPE, so a key that was never
// issued passes every commit — KAN-157 and KAN-170 were both cited before any
// ticket existed. The pre-push hook is the enforcement that closes this; these
// tests prove it actually closes it, by running the real hook against a real
// temp git repo with a fake `twg` on PATH.
//
// The fake twg is behavioral, not mocked at the module level: the hook is a
// bash script that cannot be imported, so the only faithful way to test it is
// to execute it. Same philosophy as the other governance tests — the failing
// direction is what matters, and here "failing" means a push that cites a
// nonexistent ticket going through.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK = new URL('../../.githooks/pre-push', import.meta.url);

test('pre-push hook exists and is executable', () => {
  assert.ok(fs.existsSync(HOOK), '.githooks/pre-push must exist');
  const mode = fs.statSync(HOOK).mode & 0o111;
  assert.notEqual(mode, 0, '.githooks/pre-push must be executable');
});

// The fake twg. KAN-404 reproduces the real CLI's 404 output verbatim (the
// hook keys its block decision on the "does not exist" text, so the fixture
// must carry it); KAN-999 simulates an unavailable oracle (network/auth);
// everything else succeeds. Argument shape mirrors the real CLI:
// `twg jira workitem get <key>` — the key is $4. Every lookup is logged so
// tests can assert deduplication and that no calls happen when no keys are
// cited.
function writeFakeTwg(dir) {
  const log = path.join(dir, 'twg-calls.log');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'twg'),
    `#!/usr/bin/env bash
echo "$4" >> "${log}"
if [[ "$4" == "KAN-404" ]]; then
  echo "✗ Failed jira.workitem.get."
  echo "Error: Issue does not exist or you do not have permission to see it."
  exit 1
fi
if [[ "$4" == "KAN-999" ]]; then
  echo "Error: network unreachable"
  exit 2
fi
if [[ "$4" == "KAN-640" ]]; then
  # Regression fixture: a SUCCESSFUL fetch whose body contains the phrase
  # "does not exist" — the real KAN-163 closure comment did, and the hook's
  # original naive substring match rejected a real push over it.
  #
  # KAN-221: the quotes here were escaped as \" inside a JS template literal,
  # which reached bash unescaped and printed [{key:KAN-640,...}] — not JSON at
  # all. Nothing noticed, because the hook used to decide success from a banner
  # and never read the payload. Single-quoted now so the body is the valid JSON
  # it was always meant to be.
  echo "✓ Completed jira.workitem.get."
  echo '[{"key":"KAN-640","comment":"rejects the push if the ticket does not exist, closing the failure mode"}]'
  exit 0
fi
echo "✓ Completed jira.workitem.get."
echo "[{\\"key\\":\\"$4\\"}]"
exit 0
`
  );
  fs.chmodSync(path.join(bin, 'twg'), 0o755);
  return { bin, log };
}

function makeRepo(dir, subjects) {
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) =>
    spawnSync('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });
  const init = git('init', '-q', '.');
  assert.equal(init.status, 0, 'git init failed: ' + init.stderr);
  let prev = null;
  const shas = [];
  for (const subject of subjects) {
    fs.writeFileSync(path.join(repo, 'f.txt'), subject + '\n');
    git('add', '.');
    git('commit', '-q', '-m', subject, '--no-verify', '--no-gpg-sign');
    prev = git('rev-parse', 'HEAD');
    assert.equal(prev.status, 0);
    shas.push(prev.stdout.toString().trim());
  }
  return { repo, shas };
}

function runHook(repo, { bin, line }) {
  const env = { ...process.env };
  if (bin) env.PATH = bin + path.delimiter + env.PATH;
  else env.PATH = '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin';
  return spawnSync('bash', [HOOK.pathname], {
    cwd: repo,
    input: line + '\n',
    env,
    encoding: 'utf8',
  });
}

test('push citing a nonexistent ticket is blocked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-guard-'));
  const { bin, log } = writeFakeTwg(dir);
  const { repo, shas } = makeRepo(dir, ['KAN-160: base', 'KAN-170: tip cites KAN-404 too']);
  const r = runHook(repo, {
    bin,
    line: `refs/heads/main ${shas[1]} refs/heads/main ${shas[0]}`,
  });
  assert.equal(r.status, 1, 'hook must reject: ' + r.stderr);
  assert.match(r.stderr, /KAN-404/);
  assert.match(r.stderr, /do not exist in Jira/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('push citing only existing tickets passes and deduplicates Jira lookups', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-guard-'));
  const { bin, log } = writeFakeTwg(dir);
  // The same key cited in two commits must hit Jira exactly once.
  const { repo, shas } = makeRepo(dir, ['KAN-160: base', 'KAN-170: one', 'KAN-170: two again']);
  const r = runHook(repo, {
    bin,
    line: `refs/heads/main ${shas[2]} refs/heads/main ${shas[0]}`,
  });
  assert.equal(r.status, 0, 'hook must allow: ' + r.stderr);
  assert.match(r.stdout, /validated against Jira/);
  assert.match(r.stdout, /KAN-170/);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(calls.filter((k) => k === 'KAN-170').length, 1, 'one Jira lookup per unique key, not per commit');
  assert.ok(!calls.includes('KAN-160'), 'commits below the remote tip are outside the pushed range');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('twg failure other than 404 fails OPEN with a warning, not a block', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-guard-'));
  const { bin } = writeFakeTwg(dir);
  const { repo, shas } = makeRepo(dir, ['KAN-999: oracle unreachable']);
  const r = runHook(repo, {
    bin,
    line: `refs/heads/main ${shas[0]} refs/heads/main 0000000000000000000000000000000000000000`,
  });
  assert.equal(r.status, 0, 'an unavailable oracle must not block an incident push: ' + r.stderr);
  assert.match(r.stderr, /could not verify KAN-999/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a ticket whose own body says "does not exist" still validates (regression)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-guard-'));
  const { bin } = writeFakeTwg(dir);
  const { repo, shas } = makeRepo(dir, ['KAN-640: body contains the 404 phrase']);
  const r = runHook(repo, {
    bin,
    line: `refs/heads/main ${shas[0]} refs/heads/main 0000000000000000000000000000000000000000`,
  });
  assert.equal(r.status, 0, 'a successful fetch must never be read as a 404: ' + r.stderr);
  assert.match(r.stdout, /KAN-640/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('twg missing entirely fails OPEN with a warning', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-guard-'));
  const { repo, shas } = makeRepo(dir, ['KAN-170: no oracle on this machine']);
  const r = runHook(repo, {
    bin: null,
    line: `refs/heads/main ${shas[0]} refs/heads/main ${shas[0]}`,
  });
  assert.equal(r.status, 0, 'missing twg must not block: ' + r.stderr);
  assert.match(r.stderr, /twg CLI not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('push with no ticket keys validates nothing and calls Jira zero times', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-guard-'));
  const { bin, log } = writeFakeTwg(dir);
  const { repo, shas } = makeRepo(dir, ['no ticket in this subject']);
  const r = runHook(repo, {
    bin,
    line: `refs/heads/main ${shas[0]} refs/heads/main 0000000000000000000000000000000000000000`,
  });
  assert.equal(r.status, 0, 'hook must allow: ' + r.stderr);
  assert.match(r.stdout, /no ticket keys to validate/);
  assert.ok(!fs.existsSync(log) || fs.readFileSync(log, 'utf8').trim() === '', 'no Jira calls without keys');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── KAN-221: the real twg emits JSON, not a banner ─────────────────────────
//
// The tests above all pass, and for years they gave false assurance. Their fake
// twg emits "✓ Completed jira.workitem.get." — but the twg actually installed
// on this machine emits a raw JSON array and exits 0. The hook keyed its success
// decision on the banner string, so on the real CLI every lookup fell through to
// the fail-open branch and printed "could not verify". Verified directly: even
// KAN-219, a real Done ticket, was reported as unverifiable. The guard that
// exists to block predicted keys never once blocked anything on this machine.
//
// These fixtures reproduce the real output shape verbatim.
function writeRealisticTwg(dir) {
  const log = path.join(dir, 'twg-calls.log');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'twg'),
    `#!/usr/bin/env bash
echo "$4" >> "${log}"
# Mirrors the real twg build: JSON to stdout, exit code carries the verdict,
# and NO "✓ Completed" banner anywhere.
if [[ "$4" == "KAN-404" ]]; then
  echo '{"ok": false, "error": {"code": "TWG_TOOL_EXECUTION_FAILED", "kind": "twg_tool_execution_failed", "message": "Issue does not exist or you do not have permission to see it.", "statusCode": 404}}'
  exit 1
fi
if [[ "$4" == "KAN-999" ]]; then
  echo "Error: network unreachable"
  exit 2
fi
if [[ "$4" == "KAN-641" ]]; then
  # Exits 0, but the payload is NOT a ticket: no "key" field, and it happens to
  # mention the 404 phrase. The exit-code guard on the block branch is the only
  # thing stopping this being read as a nonexistent ticket. Added because
  # mutation testing KAN-221 showed that removing that guard changed no test
  # result at all — the branch had no coverage.
  echo '{"ok": true, "note": "ticket does not exist in the local cache"}'
  exit 0
fi
echo '[{"key": "'"$4"'", "fields": {"summary": "a real ticket"}}]'
exit 0
`
  );
  fs.chmodSync(path.join(bin, 'twg'), 0o755);
  return { bin, log };
}

test('KAN-221: a real ticket validates against the real JSON-emitting twg', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-guard-'));
  const { bin } = writeRealisticTwg(dir);
  const { repo, shas } = makeRepo(dir, ['KAN-170: cites a ticket that does exist']);
  const r = runHook(repo, {
    bin,
    line: `refs/heads/main ${shas[0]} refs/heads/main 0000000000000000000000000000000000000000`,
  });
  assert.equal(r.status, 0, 'hook must allow: ' + r.stderr);
  // Before the fix this said "could not verify" and listed no validated ticket.
  assert.match(
    r.stdout,
    /validated against Jira/,
    'the hook must recognise the real twg success shape, not fall through to fail-open'
  );
  assert.match(r.stdout, /KAN-170/);
  assert.doesNotMatch(r.stderr, /could not verify/, 'no fall-through to the unverifiable branch');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('KAN-221: a nonexistent ticket is blocked against the real JSON-emitting twg', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-guard-'));
  const { bin } = writeRealisticTwg(dir);
  const { repo, shas } = makeRepo(dir, ['KAN-170: tip cites KAN-404']);
  const r = runHook(repo, {
    bin,
    line: `refs/heads/main ${shas[0]} refs/heads/main 0000000000000000000000000000000000000000`,
  });
  assert.equal(r.status, 1, 'the guard must actually block a predicted key: ' + r.stdout + r.stderr);
  assert.match(r.stderr, /KAN-404/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('KAN-221: unreachable oracle still fails OPEN against the real twg', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-guard-'));
  const { bin } = writeRealisticTwg(dir);
  const { repo, shas } = makeRepo(dir, ['KAN-999: oracle unreachable']);
  const r = runHook(repo, {
    bin,
    line: `refs/heads/main ${shas[0]} refs/heads/main 0000000000000000000000000000000000000000`,
  });
  assert.equal(r.status, 0, 'an unavailable oracle must not block an incident push: ' + r.stderr);
  assert.match(r.stderr, /could not verify KAN-999/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('KAN-221: exit 0 with no ticket payload fails OPEN even when the body mentions "does not exist"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-guard-'));
  const { bin } = writeRealisticTwg(dir);
  const { repo, shas } = makeRepo(dir, ['KAN-641: success exit but not a ticket payload']);
  const r = runHook(repo, {
    bin,
    line: `refs/heads/main ${shas[0]} refs/heads/main 0000000000000000000000000000000000000000`,
  });
  assert.equal(
    r.status,
    0,
    'the 404 phrase alone must not block when twg exited 0: ' + r.stdout + r.stderr
  );
  assert.doesNotMatch(r.stderr, /do not exist in Jira/);
  assert.match(r.stderr, /could not verify KAN-641/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('branch deletion (zero local sha) is skipped without Jira calls', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-guard-'));
  const { bin, log } = writeFakeTwg(dir);
  const { repo } = makeRepo(dir, ['KAN-404: would fail if validated']);
  const r = runHook(repo, {
    bin,
    line: 'refs/heads/gone 0000000000000000000000000000000000000000 refs/heads/gone 0000000000000000000000000000000000000000',
  });
  assert.equal(r.status, 0, 'deletion must pass: ' + r.stderr);
  assert.ok(!fs.existsSync(log) || fs.readFileSync(log, 'utf8').trim() === '', 'no Jira calls for a deletion');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────── KAN-226 ──────────────────────────────
//
// This predicate was fixed before (KAN-221) and shipped broken, because every
// fixture above emits a payload of a few dozen bytes.
//
// Under `set -uo pipefail`, `printf … | grep -q` breaks as soon as the payload
// exceeds the pipe buffer: grep -q exits at the first match, printf is still
// writing, printf dies of SIGPIPE (141), and pipefail reports 141 as the
// pipeline status. The guard read that as "key not found" and fell into its
// fail-open branch.
//
// The consequence is not cosmetic: the guard skipped validation on precisely the
// long tickets that carry a real discussion, while printing the same line it
// prints for a genuinely clean push. A fixture that fits in the buffer cannot
// detect this, which is the whole point of the fixtures below.

/** Fake twg whose successful payload is padded well past the 64 KB pipe buffer. */
function writeLargePayloadTwg(dir, { bytes = 200000 } = {}) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'twg'),
    `#!/usr/bin/env bash
if [[ "$4" == "KAN-404" ]]; then
  echo "✗ Failed jira.workitem.get."
  echo "Error: Issue does not exist or you do not have permission to see it."
  exit 1
fi
# Shape matters as much as size. grep matches a COMPLETE line, so a single
# 200 KB line makes grep read all of it before matching and the pipe never
# breaks — the fixture passes against the buggy hook. Real twg output is
# pretty-printed across many lines, so grep hits the match early and exits with
# ~169 KB still queued; that is the case that yields SIGPIPE. Measured here:
#
#   one 200 KB line   -> MATCH   (bug hidden, fixture useless)
#   multi-line JSON   -> NOMATCH (bug reproduced)
#
# The key field sits on line 5, as it does in the real payload.
pad=$(head -c ${bytes} /dev/zero | tr '\\0' 'x' | fold -w 80)
echo '['
echo '  {'
echo '    "expand": "renderedFields,names,schema",'
echo '    "id": "10252",'
echo '    "key": "'"$4"'",'
echo '    "description": "'"$pad"'"'
echo '  }'
echo ']'
exit 0
`
  );
  fs.chmodSync(path.join(bin, 'twg'), 0o755);
  return { bin };
}

test('KAN-226: a large real ticket still validates instead of failing open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-guard-'));
  const { bin } = writeLargePayloadTwg(dir);
  const { repo, shas } = makeRepo(dir, ['KAN-170: cites a real ticket with a huge description']);
  const r = runHook(repo, {
    bin,
    line: `refs/heads/main ${shas[0]} refs/heads/main 0000000000000000000000000000000000000000`,
  });
  assert.equal(r.status, 0, 'hook must allow: ' + r.stderr);
  assert.match(
    r.stdout,
    /validated against Jira/,
    'a 200 KB ticket must be recognised as real — before the fix the SIGPIPE made ' +
      'every large ticket look unverifiable, so the guard was decorative for exactly ' +
      'the tickets worth checking'
  );
  assert.doesNotMatch(
    r.stderr,
    /could not verify/,
    'the large payload must not fall through to the fail-open branch'
  );
  assert.match(r.stdout, /KAN-170/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('KAN-226: the guard never writes grep -q into a pipefail pipeline', () => {
  // A structural guard, so the regression cannot be reintroduced by editing the
  // regex rather than the pipeline: -q in any piped grep inside this hook is the
  // SIGPIPE shape regardless of which payload is being matched.
  //
  // Comments are stripped first. The hook documents this exact bug in prose that
  // contains `| grep -qE`, and a scanner that cannot tell a comment from a
  // command would flag its own explanation — which is how a guard like this
  // gets disabled instead of honoured.
  const hook = fs.readFileSync(HOOK, 'utf8');
  const code = hook
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const pipedGrepQ = code
    .split('\n')
    .filter((line) => /\|/.test(line) && /\bgrep\b[^|]*-q/.test(line));
  assert.deepEqual(
    pipedGrepQ,
    [],
    'grep -q inside a pipeline under `set -uo pipefail` reads as "not found" for any ' +
      'payload larger than the pipe buffer, because grep exits early and printf dies ' +
      'of SIGPIPE. Drop -q so grep reads to EOF: ' + pipedGrepQ.join(' | ')
  );
  // The scanner must not be vacuous: it has to still see the pipelines that ARE
  // present, or it would pass on a hook containing no grep at all.
  assert.match(
    code,
    /\| grep -E/,
    'the hook must still contain piped greps for this check to mean anything'
  );
});

test('KAN-226: the hook really does run under pipefail (the precondition)', () => {
  // If `set -uo pipefail` were ever dropped, the structural test above would
  // start passing for the wrong reason and the bug could return unnoticed.
  const hook = fs.readFileSync(HOOK, 'utf8');
  assert.match(
    hook,
    /^set -uo pipefail$/m,
    'the hook must keep pipefail for the SIGPIPE analysis to hold'
  );
});


test('KAN-226: a large nonexistent ticket is still BLOCKED, not failed open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-guard-'));
  const { bin } = writeLargePayloadTwg(dir);
  const { repo, shas } = makeRepo(dir, ['KAN-170: cites KAN-404 with a huge payload']);
  const r = runHook(repo, {
    bin,
    line: `refs/heads/main ${shas[0]} refs/heads/main 0000000000000000000000000000000000000000`,
  });
  assert.equal(
    r.status,
    1,
    'the guard must block a predicted key even when the 404 body is large: ' + r.stdout + r.stderr
  );
  assert.match(r.stderr, /KAN-404/);
  fs.rmSync(dir, { recursive: true, force: true });
});

