// ============================================================
// Action pin + runner image oracle (KAN-227, KAN-228)
//
// Two properties that only ever regress silently:
//
//   KAN-227  23 action pins targeted Node 20. Node 20 hit
//            end-of-life Apr 2026, runners defaulted to Node 24
//            on Jun 16, and Node 20 was REMOVED from GitHub
//            Actions on Sep 23 2026 - eight days before the
//            ticket was filed. Pipelines stayed green only
//            because GitHub was still routing these actions onto
//            Node 24 through a forced fallback. That is the
//            state where everything works and nothing says why.
//
//   KAN-228  all 13 runs-on: used the floating `ubuntu-latest`
//            label. Upstream rolls it to Ubuntu 26.04 from
//            Oct 19 2026 (runner-images#14748). A floating label
//            means the image moves under the repo with no commit
//            and no diff.
//
// KAN-227's own note is the finding this file answers: "Nothing in
// the repo asserts anything about action runtime versions, so a
// future pin re-introducing @v4 would pass every test."
//
// WHY THE RUNTIMES ARE A LITERAL HERE AND NOT A FETCH.
//
// `action-runtime-pins.test.mjs` cannot look them up. CI job 0 runs
// before any `npm ci`, the guards must pass with no egress, and a
// fetch that fails would have to be interpreted - which is the
// fail-open shape this repo has already been bitten by twice
// (KAN-173, KAN-226). So the table is data, it records where it
// came from, and it is expected to go stale on a GitHub
// deprecation cycle rather than silently.
//
// WHY action.yml AND NOT THE RELEASE NOTES.
//
// `actions/upload-artifact@v5` is the reason. Its release notes
// read "**BREAKING CHANGE:** this update supports Node v24.x",
// and its action.yml says `using: node20`. A bump that followed
// the notes would have looked correct, been recorded as done in
// the changelog, and left the repo on the removed runtime. That
// is why upload-artifact's floor is 6 and not 5.
//
// Every runtime below was read from `runs.using` in the action.yml
// at the named tag. Measured 2026-10-01; re-measure before
// raising any floor.
// ============================================================

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, resolved from this file so any test can use the helper. */
export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const WORKFLOW_DIR = join(REPO_ROOT, '.github/workflows');

/**
 * Lowest acceptable major per action, and why.
 *
 * `floor` is a major, not a version string, because the repo's
 * convention is to pin majors and tests compare majors.
 *
 * `runtimeAtFloor` exists so the test can assert a positive fact -
 * "the floor is a node24 tag" - rather than only the negative one.
 * A floor with no recorded runtime could be wrong in the
 * direction that matters.
 */
export const PIN_FLOORS = Object.freeze([
  Object.freeze({
    action: 'actions/checkout',
    current: '@v4',
    floor: 7,
    currentRuntime: 'node20',
    runtimeAtFloor: 'node24',
    reason:
      'v5 = node24 and declares min runner v2.327.1. v6 additionally ' +
      'persists creds to a separate file. v7 blocks fork-PR checkout ' +
      'under pull_request_target / workflow_run - neither trigger is ' +
      'declared in any workflow here, so v7 is safe on that count.',
  }),
  Object.freeze({
    action: 'actions/setup-node',
    current: '@v4',
    floor: 7,
    currentRuntime: 'node20',
    runtimeAtFloor: 'node24',
    reason:
      'v5 = node24. v5/v6 add automatic caching when packageManager is ' +
      'set, and v7 removes the dummy NODE_AUTH_TOKEN export. Neither ' +
      'applies here: no package.json in this repo declares a ' +
      'packageManager field, and no step reads NODE_AUTH_TOKEN.',
  }),
  Object.freeze({
    action: 'actions/setup-python',
    current: '@v5',
    floor: 7,
    currentRuntime: 'node20',
    runtimeAtFloor: 'node24',
    reason:
      'v6 = node24. v7 removes the pip-install input. All three call ' +
      'sites pass only python-version, so the removal is not reachable.',
  }),
  Object.freeze({
    action: 'actions/upload-artifact',
    current: '@v4',
    floor: 6,
    currentRuntime: 'node20',
    runtimeAtFloor: 'node24',
    reason:
      'THE FLOOR IS 6, NOT 5. v5 release notes announce Node 24; its ' +
      'action.yml still declares using: node20. v6 is the first tag ' +
      'that actually runs on node24. v7 adds opt-in direct uploads and ' +
      'does not change defaults.',
  }),
  Object.freeze({
    action: 'gitleaks/gitleaks-action',
    current: '@v2',
    floor: 3,
    currentRuntime: 'node20',
    runtimeAtFloor: 'node24',
    reason:
      'v3 = node24 and changes no inputs, outputs or behaviour. Its ' +
      'action.yml still declares NO inputs at all, so the ' +
      'GITLEAKS_CONFIG env-var mechanism this repo depends on carries ' +
      'over. Highest-stakes item in the set: this is the secret gate, ' +
      'and a gate that looks green while scanning with the wrong ' +
      'ruleset is worse than no gate because it is trusted.',
  }),
]);

/** action -> floor entry, for O(1) lookup during a scan. */
const FLOOR_BY_ACTION = new Map(PIN_FLOORS.map((f) => [f.action, f]));

/** Explicit runner image this repo targets. KAN-228 decision: migrate
 *  deliberately now, while ubuntu-latest is still 24.04, so a failure
 *  is attributable to the image rather than to the label moving. */
export const TARGET_RUNNER = 'ubuntu-26.04';

/**
 * Strip comments the way scripts/validate-workflows.py does.
 *
 * Two distinct cases, handled separately rather than in one pass:
 * a line whose first non-space char is `#` is a comment block, and a
 * `#` after a value truncates it. ci.yml has both, and a single-pass
 * strip either keeps the comment text or drops real content.
 */
export function stripComment(line) {
  const hash = line.indexOf('#');
  if (hash === -1) return line;
  const before = line.slice(0, hash);
  const after = line.slice(hash + 1);
  // A `#` only opens a comment at the start of the line or after
  // whitespace. `gite#aks` is not a comment, and neither is an
  // unquoted URL fragment. Cheap and enough for workflow YAML.
  const opensAtStart = before.trim() === '';
  const opensAfterSpace = before.length > 0 && /\s$/.test(before);
  return opensAtStart || opensAfterSpace ? before : line;
}

/**
 * Parse one `uses:` value into an action pin.
 *
 * Returns `{ owner, repo, ref, major }` for a real pin, or null.
 * null covers two cases the caller MUST distinguish, and
 * `scanActionPins` does:
 *
 *   not-a-pin      a local `./action`, a docker ref, a comment
 *   unparseable    a branch name or a commit SHA
 *
 * Collapsing both into null would exempt the most rigorous pin form
 * there is (a SHA) from the gate - the guard quietly passing the best
 * case is worse than the guard failing the worst one.
 */
export function parseUsesPin(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Local actions and docker refs are out of scope for a version floor.
  if (trimmed.startsWith('./') || trimmed.startsWith('docker://')) return null;

  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return null;

  const repoPart = trimmed.slice(0, at);
  const ref = trimmed.slice(at + 1);
  if (!ref) return null;

  const slash = repoPart.indexOf('/');
  if (slash <= 0) return null;

  // A leading digits-only path is a docker-style or otherwise non-action
  // ref. Actions are always `owner/repo[/subpath]`.
  if (/^\d/.test(repoPart)) return null;

  const owner = repoPart.slice(0, slash);
  const rest = repoPart.slice(slash + 1);
  if (!owner || !rest) return null;

  // A SHA looks exactly like a major when it happens to start with a
  // digit. `actions/checkout@8f4b7f8486...` would otherwise parse as
  // major 8 and sail past every floor - the guard silently exempting
  // the most rigorous pin form there is. A commit SHA is 7+ hex
  // chars; a version major is at most 3 and never mixed-case hex
  // followed by more hex, so require the ref to stop being hex
  // before accepting it as a major.
  const looksLikeSha = /^[0-9a-f]{7,40}$/i.test(ref);
  // Branch names that begin with a digit have the same shape.
  const looksLikeBranch = /[A-Za-z_./-]/.test(ref.replace(/^v?\d+(\.\d+)*/, ''));
  const m = /^v?(\d{1,3})(?:\.\d+)*$/.exec(ref);
  const major = m && !looksLikeSha && !looksLikeBranch ? Number(m[1]) : null;

  // `owner/repo` is the canonical identity; a subpath (owner/repo/path)
  // is the same action and shares its floor.
  const segs = rest.split('/');
  const repo = segs[0];

  return { owner, repo, ref, major, action: `${owner}/${repo}` };
}

/** Every `uses:` pin across every workflow, with file and line. */
export function collectPins(repoRoot = REPO_ROOT) {
  const dir = join(repoRoot, '.github/workflows');
  const out = [];
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const lines = readFileSync(join(dir, file), 'utf8').split('\n');
    lines.forEach((raw, i) => {
      const line = stripComment(raw);
      const m = /^\s*-?\s*uses:\s*(\S.*)$/.exec(line);
      if (!m) return;
      const pin = parseUsesPin(m[1]);
      out.push({
        file: `.github/workflows/${file}`,
        line: i + 1,
        raw: m[1].trim(),
        pin,
      });
    });
  }
  return out;
}

/** Every `runs-on:` value across every workflow, with file and line. */
export function collectRunnerImages(repoRoot = REPO_ROOT) {
  const dir = join(repoRoot, '.github/workflows');
  const out = [];
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const lines = readFileSync(join(dir, file), 'utf8').split('\n');
    lines.forEach((raw, i) => {
      const line = stripComment(raw);
      const m = /^\s*runs-on:\s*(.+?)\s*$/.exec(line);
      if (!m) return;
      out.push({
        file: `.github/workflows/${file}`,
        line: i + 1,
        value: m[1],
      });
    });
  }
  return out;
}

/**
 * Scan every pin against PIN_FLOORS.
 *
 * Three failure classes rather than one boolean, so the message says
 * which mistake was made. `unparsed` is the important one: a scanner
 * that silently skips what it does not understand is how a pin
 * escapes a gate.
 */
export function scanActionPins(repoRoot = REPO_ROOT) {
  const belowFloor = [];
  const node20 = [];
  const unparsed = [];
  let checked = 0;

  for (const { file, line, raw, pin } of collectPins(repoRoot)) {
    const where = `${raw} in ${file}:${line}`;

    if (!pin) continue; // local action / docker ref - out of scope
    const floor = FLOOR_BY_ACTION.get(pin.action);
    if (!floor) continue; // third-party action, no floor recorded
    checked += 1;

    if (pin.major === null) {
      unparsed.push(
        `${where} — pinned to "${pin.ref}", which has no parseable major. ` +
          'A branch or SHA ref cannot be checked against a version floor, so ' +
          'this scanner treats it as unverified rather than passing. Pin a ' +
          'released major, or record its floor in PIN_FLOORS.'
      );
      continue;
    }

    if (pin.major < floor.floor) {
      belowFloor.push(
        `${where} — ${pin.action} is pinned at v${pin.major}, floor is ` +
          `v${floor.floor}. ${floor.reason}`
      );
    }

    // A pin at or above the floor is acceptable only if the floor tag
    // itself is a node24 tag. Checking the table rather than only the
    // pin means a future release that re-introduced node20 ABOVE the
    // floor cannot pass, which a bare major comparison would allow.
    if (pin.major >= floor.floor && floor.runtimeAtFloor !== 'node24') {
      node20.push(
        `${where} — ${pin.action} is at v${pin.major}, at or above the ` +
          `floor v${floor.floor}, but that floor is recorded as ` +
          `${floor.runtimeAtFloor}. Re-measure PIN_FLOORS against ` +
          'action.yml before trusting this pin.'
      );
    }
  }

  return {
    ok: belowFloor.length === 0 && node20.length === 0 && unparsed.length === 0,
    checked,
    belowFloor,
    node20,
    unparsed,
  };
}

/** Scan every `runs-on:` for a floating label or an unpinned job. */
export function scanRunnerImages(repoRoot = REPO_ROOT) {
  const floating = [];
  const unpinned = [];
  const majors = new Set();
  let checked = 0;

  for (const { file, line, value } of collectRunnerImages(repoRoot)) {
    const where = `${value} in ${file}:${line}`;
    // A template's resolution depends on a matrix this repo does not
    // define. Guessing would be exactly the optimistic read this repo
    // keeps getting bitten by.
    if (value.includes('${{')) {
      unpinned.push(`${where} — a templated runner label cannot be verified against a pin`);
      continue;
    }
    checked += 1;
    if (/-latest\b/.test(value)) {
      floating.push(
        `${where} — floating label. ubuntu-latest rolls to 26.04 from ` +
          'Oct 19 2026 (runner-images#14748), so this image would change ' +
          'with no commit and no diff.'
      );
      continue;
    }
    const m = /^ubuntu-(\d+)\.(\d+)$/.exec(value);
    if (!m) {
      unpinned.push(`${where} — not an explicit ubuntu-<major>.<minor> label`);
      continue;
    }
    majors.add(m[1]);
  }

  // A half-migrated runner set is the exact state in which a failure is
  // unattributable, which is the reason KAN-228 exists.
  const mixed = majors.size > 1;

  return {
    ok: floating.length === 0 && unpinned.length === 0 && !mixed,
    checked,
    floating,
    unpinned,
    majors: [...majors].sort(),
    mixed,
  };
}