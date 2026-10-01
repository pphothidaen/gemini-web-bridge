// Production host invariant (KAN-223).
//
// The Cloudflare account migration in fa97a5d moved production from
// gemini-web-bridge.pansakorn-pho.workers.dev to prod.gemini-web-bridge.workers.dev,
// leaving the old worker running as a rollback target. That rollback target is
// the worst kind of failure surface: it still answers 200, still serves /mcp,
// and still lists all 9 MCP tools. A client configured against it therefore
// reports NO error at all — tools/list succeeds, and the first symptom is an
// empty model catalogue:
//
//   { "object": "list", "data": [], "default_recommended": null,
//     "browser_active_model": {"model": null}, "status": "disconnected" }
//
// That is exactly what happened on 2026-10-01, and the root cause was a single
// stale URL in a client config nobody could trace back to a repo file, because
// 15 tracked files still named the retired host — including copy-pasteable
// config blocks in IDEA.md and an actionable rotation runbook in
// docs/SECURITY_TOKEN_ROTATION.md.
//
// A one-time sweep decays: the next doc edit reintroduces the old host and
// nothing notices, because no code path is involved for a human to get wrong.
// So the invariant is written down here and enforced on every test run, in the
// same spirit as cd-concurrency-audit.test.mjs and governance-pre-push.test.mjs:
// the failing direction is the point — a tracked file naming the retired host
// as a live endpoint going unnoticed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const CANONICAL_HOST = 'prod.gemini-web-bridge.workers.dev';

// Retired by fa97a5d. Kept running as a rollback target, permanently
// DISCONNECTED, so it fails silently rather than loudly.
const RETIRED_HOST = 'gemini-web-bridge.pansakorn-pho.workers.dev';

// The staging worker named in the Phase 5 rollout plan never existed as a
// deployment — the plan describes it aspirationally. Same silent-failure shape,
// so it is pinned here too.
const RETIRED_STAGING_HOST = 'gemini-web-bridge-staging.pansakorn-pho.workers.dev';

// Files allowed to name the retired host, each with the reason it is
// legitimate. Anything not on this list that names the retired host is a defect.
//
// The rule is "historical evidence only": a file may say what the old host WAS,
// never hand it out as something to point a client at.
const HISTORICAL_ALLOWLIST = new Map([
  [
    'IMPLEMENTATION_SUMMARY.md',
    'records the pre-migration pphothidaen-vs-pansakorn-pho account decision',
  ],
  [
    'PHASE5_EXECUTION_REPORT.md',
    'dated 2026-09-27 verification report; the host is what the run exercised',
  ],
  [
    'docs/verification/e2e-extension-bridge-2026-09-27.md',
    'the migration evidence itself, including the before/after host table',
  ],
  [
    'PHASE5_INTEGRATION_TEST_ROLLOUT.json',
    'aspirational staging rollout plan; staging was never deployed (KAN-130)',
  ],
  [
    'SESSION_HANDOFF_2026-09-30.md',
    'names the retired host explicitly as "stale host, do NOT use"',
  ],
  [
    'SESSION_HANDOFF_2026-10-01.md',
    'names the retired host explicitly as a trap to avoid, same as the ' +
      '2026-09-30 handoff above it; carries the banner for the same reason',
  ],
  [
    'HANDOFF.md',
    'banner names the retired host as the one this stale doc must not be used for',
  ],
  [
    '.clinerules/02-bridge-api.md',
    'agent rules; names the old host as a trap to avoid',
  ],
  [
    'CHANGELOG.md',
    'records KAN-223 itself, the sweep that retired the old host everywhere else',
  ],
]);

const SCAN_EXTENSIONS = new Set([
  '.md', '.json', '.js', '.mjs', '.sh', '.py', '.yml', '.yaml', '.jsonc', '.html',
]);
const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', 'release', 'dist', '.wrangler', '__pycache__', 'artifacts',
]);

// `--cached --others --exclude-standard` is exactly "what could be committed":
// tracked files plus new untracked files, minus anything .gitignore already
// rejects. Deriving the set from git rather than a hand-rolled skip list is what
// keeps this test honest — secrets and build output are excluded by the same
// rules that exclude them from the commit, so the two cannot drift apart.
function scanTargets() {
  const seen = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
        seen.add(path.relative(ROOT, path.join(dir, entry.name)));
      }
    }
  };
  walk(ROOT);

  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, 'git ls-files failed: ' + r.stderr);
  const committable = new Set(
    r.stdout
      .split('\n')
      .filter(Boolean)
      .filter((f) => SCAN_EXTENSIONS.has(path.extname(f)))
  );

  return [...seen]
    .filter((rel) => committable.has(rel))
    // This file necessarily spells both retired hosts out — it is the thing
    // that forbids them elsewhere, so it is not an offender against itself.
    .filter((rel) => rel !== path.relative(ROOT, fileURLToPath(import.meta.url)))
    .sort();
}

const TARGETS = scanTargets();

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('the canonical production host is pinned where the spec says it is', () => {
  const pkg = JSON.parse(read('cloudflare-worker/package.json'));
  assert.ok(pkg.version, 'package.json must carry a version to compare against /health');

  // The spec is the declared source of truth for endpoints, so that is where
  // the canonical host has to appear; client-configs.md is what people copy.
  assert.ok(
    read('docs/api-spec.md').includes(`https://${CANONICAL_HOST}`),
    `docs/api-spec.md must name ${CANONICAL_HOST} as BASE`
  );
  assert.ok(
    read('docs/client-configs.md').includes(CANONICAL_HOST),
    `docs/client-configs.md must name ${CANONICAL_HOST}`
  );

  // The extension's built-in default is the one endpoint that cannot be fixed
  // by editing a config file at runtime — it is compiled into settings.js and
  // decides where the WebSocket goes when the user has not overridden it.
  assert.ok(
    read('extension-cloudflare/content.js').includes(CANONICAL_HOST),
    `extension-cloudflare/content.js DEFAULT_WORKER_URL must be ${CANONICAL_HOST}`
  );

  // Deliberately NOT asserted here: `cloudflare-worker/.env`.
  //
  // The first run of this test failed in CI for exactly that reason. .env is
  // gitignored, so it exists on a developer machine and not on the runner — a
  // test that reads it passes locally and fails in CI, which is the worst
  // possible split. The env file is a local deployment artifact, not a tracked
  // authority: when the two disagree the spec is right and the local file is
  // stale, and the rotation workflow owns keeping it in step.
});

test('no committable file outside the allowlist names the retired production host', () => {
  const offenders = TARGETS.filter(
    (rel) => read(rel).includes(RETIRED_HOST) && !HISTORICAL_ALLOWLIST.has(rel)
  );
  assert.deepEqual(
    offenders,
    [],
    'these files name the retired host ' +
      `${RETIRED_HOST} but are not on the historical allowlist. That host still ` +
      'returns 200 and still lists all 9 MCP tools, so a config copied from it ' +
      `connects fine and then reports an empty model catalogue. Repoint to ${CANONICAL_HOST}, ` +
      'or — if the file is genuinely historical evidence — add it to ' +
      'HISTORICAL_ALLOWLIST in this test with a reason, so the exception is deliberate. '
  );
});

test('the staging host is still only in the rollout plan that never deployed', () => {
  const offenders = TARGETS.filter(
    (rel) =>
      read(rel).includes(RETIRED_STAGING_HOST) && rel !== 'PHASE5_INTEGRATION_TEST_ROLLOUT.json'
  );
  assert.deepEqual(
    offenders,
    [],
    'the staging worker was never deployed (KAN-130); any other file naming it ' +
      'is pointing a reader at a host that does not exist. '
  );
});

test('the historical allowlist has not rotted into a blanket exemption', () => {
  // An allowlist nobody prunes stops being an allowlist. Every entry must still
  // exist, must still name the retired host (otherwise the file was rewritten
  // and the exemption is dead weight), and must still carry a real reason.
  for (const [rel, reason] of HISTORICAL_ALLOWLIST) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `allowlist entry ${rel} no longer exists — remove it`);
    assert.ok(reason && reason.length > 20, `allowlist entry ${rel} needs a real reason, not a placeholder`);
    const contents = read(rel);
    assert.ok(
      contents.includes(RETIRED_HOST) || contents.includes(RETIRED_STAGING_HOST),
      `allowlist entry ${rel} no longer names the retired host — the exemption is obsolete, remove it`
    );
  }
});

test('every allowlisted file warns the reader at the top that the host is retired', () => {
  // The allowlist permits the mention, not the ambiguity. Each of these files
  // is read by someone deciding where to point a client, so the retired host
  // must be labelled rather than left to be discovered at runtime.
  for (const rel of HISTORICAL_ALLOWLIST.keys()) {
    // A JSON file cannot carry a Markdown banner, so the equivalent marker is a
    // leading `_note`. Anything else must say so in prose near the top. The
    // Thai markers are real: the governance rules under .clinerules/ are
    // written in Thai, and a rule file that fails this check would push the
    // author to delete the warning rather than translate it.
    const marker = rel.endsWith('.json')
      ? /^\s*\{\s*"(?:_note|_comment)"/m
      : /HISTORICAL|Stale host|stale|retired|RETIRED|superseded|do NOT use|host เก่า|เก่า \(ก่อน migration\)/i;
    assert.match(
      read(rel).slice(0, 2500),
      marker,
      `${rel} names the retired host but its opening does not tell the reader it is ` +
        (rel.endsWith('.json')
          ? 'historical — add a leading "_note" key, or drop the mention'
          : 'historical — add a banner, or drop the mention')
    );
  }
});

test('the sweep is not vacuous — it actually reads the files it claims to', () => {
  // A governance test that silently scans nothing is worse than none: it goes
  // green forever. Guard the guard.
  assert.ok(
    TARGETS.length > 20,
    `expected to scan the repo, found only ${TARGETS.length} files — the walk is broken`
  );
  for (const required of [
    'docs/api-spec.md',
    'IDEA.md',
    'cloudflare-worker/src/index.js',
    'extension-cloudflare/content.js',
  ]) {
    assert.ok(TARGETS.includes(required), `the scan must cover ${required}`);
  }
});