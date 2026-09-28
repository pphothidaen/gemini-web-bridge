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
