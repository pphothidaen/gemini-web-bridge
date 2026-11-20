import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CI_PATH = path.join(REPO_ROOT, '.github/workflows/ci.yml');
const CI_CONTENT = fs.readFileSync(CI_PATH, 'utf8');

test('jira-sync job does not use env in step if-condition (breaks GitHub Actions secret expression)', () => {
  // Step-level `if: ${{ env.JIRA_CI_TOKEN != '' }}` is silently evaluated as false
  // because GitHub Actions blanks secret values in expression context.
  // The check must be handled inside the step script instead.
  const jiraJob = CI_CONTENT.split('jira-sync:')[1]?.split('redteam-token-test:')[0] || '';
  assert.ok(jiraJob, 'jira-sync job must exist in ci.yml');
  assert.doesNotMatch(
    jiraJob,
    /if:\s*\${{\s*env\.JIRA_CI_TOKEN/,
    'jira-sync step must not use env.JIRA_CI_TOKEN in an if-condition'
  );
  assert.match(
    jiraJob,
    /if \[ -z "\$JIRA_CI_TOKEN" \]/,
    'jira-sync script must check JIRA_CI_TOKEN inside bash'
  );
});

test('jira-sync job supports JIRA_API_TOKEN, JIRA_TOKEN, and JIRA_EMAIL aliases', () => {
  const jiraJob = CI_CONTENT.split('jira-sync:')[1]?.split('redteam-token-test:')[0] || '';
  assert.match(
    jiraJob,
    /JIRA_CI_TOKEN: \${{ secrets\.JIRA_CI_TOKEN \|\| secrets\.JIRA_API_TOKEN/,
    'jira-sync must fall back to secrets.JIRA_API_TOKEN'
  );
  assert.match(
    jiraJob,
    /JIRA_EMAIL:.*vars\.JIRA_ACCOUNT_EMAIL.*vars\.JIRA_EMAIL/,
    'jira-sync must support vars.JIRA_EMAIL fallback'
  );
});

test('jira-sync commit key extraction supports standard, bracketed, lowercase, merge, and branch refs', () => {
  const extractKey = (commitMsg, branchRef = '') => {
    const match = commitMsg.match(/KAN-[0-9]+/i);
    if (match) return match[0].toUpperCase();
    if (branchRef) {
      const bMatch = branchRef.match(/KAN-[0-9]+/i);
      if (bMatch) return bMatch[0].toUpperCase();
    }
    return '';
  };

  assert.equal(extractKey('KAN-347: feat: add load tests'), 'KAN-347');
  assert.equal(extractKey('[KAN-122] docs: update architecture'), 'KAN-122');
  assert.equal(extractKey('kan-45: lowercase key'), 'KAN-45');
  assert.equal(extractKey('[kan-99] lowercase bracketed'), 'KAN-99');
  assert.equal(
    extractKey('Merge pull request #24 from branch\n\nKAN-236: Fix retryViaUi'),
    'KAN-236'
  );
  assert.equal(
    extractKey('Merge pull request #25 from branch\n\nkan-347: Fix retryViaUi'),
    'KAN-347'
  );
  assert.equal(extractKey('chore: bump deps without ticket in msg', 'feature/kan-555-tool-call'), 'KAN-555');
  assert.equal(extractKey('chore: bump deps without ticket'), '');
});

test('jira-sync comment builds a valid GitHub commit link with repo path', () => {
  const jiraJob = CI_CONTENT.split('jira-sync:')[1]?.split('redteam-token-test:')[0] || '';
  // Must NOT be `\($srv)/commit/\($sha)` which generates 404 URL `https://github.com/commit/<sha>`
  assert.ok(
    !jiraJob.includes('(\\($srv)/commit/'),
    'jira-sync must not generate broken https://github.com/commit/<sha> links'
  );
  assert.ok(
    jiraJob.includes('\\($srv)/\\($repo)/commit/\\($sha)'),
    'jira-sync must generate https://github.com/<repo>/commit/<sha> links'
  );
});

test('jira-sync comment builds rich Atlassian Document Format (ADF) with bulletList and marks', () => {
  const jiraJob = CI_CONTENT.split('jira-sync:')[1]?.split('redteam-token-test:')[0] || '';
  assert.match(jiraJob, /type:\s*"bulletList"/, 'jira-sync ADF must use bulletList structure');
  assert.match(jiraJob, /marks:\s*\[\{\s*type:\s*"strong"\s*\}\]/, 'jira-sync ADF must format version in bold strong');
  assert.match(jiraJob, /marks:\s*\[\{\s*type:\s*"code"\s*\}\]/, 'jira-sync ADF must format artifact in code font');
});

test('jira-sync job runs on main, develop, and workflow_dispatch', () => {
  const jiraJob = CI_CONTENT.split('jira-sync:')[1]?.split('redteam-token-test:')[0] || '';
  assert.match(
    jiraJob,
    /github\.ref == 'refs\/heads\/main' \|\| github\.ref == 'refs\/heads\/develop' \|\| github\.event_name == 'workflow_dispatch'/,
    'jira-sync must trigger on main, develop, and manual workflow_dispatch'
  );
});

test('redteam-token-test extracts token value cleanly stripping Bearer prefix and all whitespace', () => {
  const parseToken = (header, tokenArg = '') => {
    if (tokenArg && tokenArg.trim()) return tokenArg.trim();
    let tok = header.replace(/^[^:]*:\s*/, '');
    tok = tok.replace(/^Bearer\s*/, '');
    tok = tok.replace(/\s+/g, '');
    return tok;
  };

  assert.equal(parseToken('Authorization: Bearer '), '');
  assert.equal(parseToken('Authorization: Bearer  '), '');
  assert.equal(parseToken('Authorization: Bearer   '), '');
  assert.equal(parseToken('Authorization: Bearer secret-key-123'), 'secret-key-123');
  assert.equal(parseToken('Authorization: Bearer secret-key-123', 'secret-key-123'), 'secret-key-123');
  assert.equal(parseToken('x-bridge-token: '), '');
  assert.equal(parseToken('x-bridge-token:   '), '');
  assert.equal(parseToken('x-bridge-token: bridge-auth-456'), 'bridge-auth-456');
});

test('redteam-token-test in ci.yml strips Bearer prefix and all spaces before emptiness assertion', () => {
  const redteamJob = CI_CONTENT.split('redteam-token-test:')[1] || '';
  assert.ok(redteamJob, 'redteam-token-test job must exist in ci.yml');
  assert.match(
    redteamJob,
    /tok="\${tok#Bearer }"/,
    'assert_valid and assert_revoked must strip Bearer prefix'
  );
  assert.match(
    redteamJob,
    /tok="\${tok\/\/ \/}"/,
    'assert_valid and assert_revoked must strip all spaces to handle multi-space trailing padding'
  );
});

test('redteam-token-test is active on CI with !cancelled() and without main-only gate', () => {
  const redteamJob = CI_CONTENT.split('redteam-token-test:')[1] || '';
  assert.match(
    redteamJob,
    /if:\s*(\${{\s*)?!cancelled\(\)(\s*}})?/,
    'redteam-token-test must have if: ${{ !cancelled() }} to run across all CI events'
  );
  assert.doesNotMatch(
    redteamJob.split('steps:')[0],
    /github\.ref == 'refs\/heads\/main'/,
    'redteam-token-test job must not be restricted to main only so it executes on CI pull requests'
  );
});

test('redteam-token-test supports CLIENT_API_TOKEN, CLIENT_TOKEN, and BRIDGE_SECRET aliases', () => {
  const redteamJob = CI_CONTENT.split('redteam-token-test:')[1] || '';
  assert.match(
    redteamJob,
    /CURRENT_CLIENT_TOKEN: \${{ secrets\.CLIENT_API_KEY \|\| secrets\.CLIENT_API_TOKEN/,
    'redteam must support secrets.CLIENT_API_TOKEN'
  );
  assert.match(
    redteamJob,
    /CURRENT_BRIDGE_AUTH_TOKEN: \${{ secrets\.BRIDGE_AUTH_TOKEN \|\| secrets\.BRIDGE_SECRET/,
    'redteam must support secrets.BRIDGE_SECRET'
  );
});

// ─── AI-SDLC & HITL Governance Gate Tests ─────────────────────────────
const HITL_PATH = path.join(REPO_ROOT, '.github/workflows/hitl-pr-gate.yml');
const HITL_CONTENT = fs.readFileSync(HITL_PATH, 'utf8');

test('hitl-pr-gate.yml triggers on pull_request, push, and workflow_dispatch', () => {
  assert.match(HITL_CONTENT, /pull_request:\s*\n\s*branches:\s*\[main,\s*develop\]/, 'hitl-pr-gate must trigger on PRs to main, develop');
  assert.match(HITL_CONTENT, /push:\s*\n\s*branches:\s*\[main,\s*develop\]/, 'hitl-pr-gate must trigger on push to main, develop');
  assert.match(HITL_CONTENT, /workflow_dispatch:/, 'hitl-pr-gate must support manual workflow_dispatch');
});

test('hitl-pr-gate.yml enforces Zero Standing Privileges', () => {
  assert.match(HITL_CONTENT, /permissions:\s*\n\s*contents:\s*read\s*\n\s*pull-requests:\s*read\s*\n\s*statuses:\s*write/);
});

test('hitl-pr-gate.yml baseline step checks docs/architecture.md and at least 4 ADRs', () => {
  assert.match(HITL_CONTENT, /test -f docs\/architecture\.md/);
  assert.match(HITL_CONTENT, /find docs\/adr -maxdepth 1 -name "00\*\.md"/);
  assert.match(HITL_CONTENT, /\[ "\$ADR_COUNT" -lt 4 \]/);
});

test('Tier 3 File Change Detection covers both cloudflare-worker/src/ and dist/extension/', () => {
  assert.match(
    HITL_CONTENT,
    /\^\(cloudflare-worker\/src\/\|dist\/extension\/\)/,
    'Tier 3 check must match both cloudflare-worker/src/ and dist/extension/'
  );
});

test('Tier 3 File Change Detection step is active across all event types without PR gating', () => {
  const step2 = HITL_CONTENT.split('2. Tier 3 File Change Detection & ADR Enforcement')[1]?.split('3. Verify Branch Protection & No Self-Bypass')[0] || '';
  assert.ok(step2, 'Step 2 must exist');
  assert.doesNotMatch(
    step2.split('run:')[0],
    /if:\s*github\.event_name == 'pull_request'/,
    'Step 2 must not be gated by pull_request only, must be active on push and workflow_dispatch'
  );
});

test('Tier 3 enforcement requires Ticket ID and checks ADR baseline/references', () => {
  const step2 = HITL_CONTENT.split('2. Tier 3 File Change Detection & ADR Enforcement')[1]?.split('3. Verify Branch Protection & No Self-Bypass')[0] || '';
  assert.match(step2, /grep -qE "\\b\(KAN\|PROJ\|GH\)-\[0-9\]\+\\b"/, 'Must require Ticket ID');
  assert.match(step2, /docs\/adr\//, 'Must check docs/adr/ for ADR document or baseline');
});

test('Verify Branch Protection & No Self-Bypass is active across all event types', () => {
  const step3 = HITL_CONTENT.split('3. Verify Branch Protection & No Self-Bypass')[1] || '';
  assert.ok(step3, 'Step 3 must exist');
  assert.doesNotMatch(
    step3.split('run:')[0],
    /if:\s*github\.event_name == 'pull_request'/,
    'Step 3 must not be gated by pull_request only'
  );
  assert.match(step3, /Automated Agent \/ Bot PR detected/, 'Must detect automated agent/bot');
  assert.match(step3, /Self-Bypass Blocked/, 'Must block self-bypass attempts');
  assert.match(step3, /Zero Standing Privileges/, 'Must enforce Zero Standing Privileges');
});

test('hitl-pr-gate.yml uses env variables to prevent bash injection from GitHub context objects', () => {
  const step2 = HITL_CONTENT.split('2. Tier 3 File Change Detection & ADR Enforcement')[1]?.split('3. Verify Branch Protection & No Self-Bypass')[0] || '';
  assert.match(step2, /PR_TITLE:\s*\${{\s*github\.event\.pull_request\.title\s*}}/, 'Step 2 must bind PR_TITLE in env block');
  assert.match(step2, /EVENT_NAME:\s*\${{\s*github\.event_name\s*}}/, 'Step 2 must bind EVENT_NAME in env block');
  assert.doesNotMatch(
    step2.split('run:')[1] || '',
    /\${{\s*github\.event\.pull_request\.title/,
    'Step 2 run script must not interpolate PR title directly inside bash'
  );

  const step3 = HITL_CONTENT.split('3. Verify Branch Protection & No Self-Bypass')[1] || '';
  assert.match(step3, /PR_AUTHOR:\s*\${{\s*github\.event\.pull_request\.user\.login\s*}}/, 'Step 3 must bind PR_AUTHOR in env block');
  assert.match(step3, /ACTOR:\s*\${{\s*github\.actor\s*}}/, 'Step 3 must bind ACTOR in env block');
});

test('hitl-pr-gate.yml enforces cited ADR existence in docs/adr/', () => {
  const step2 = HITL_CONTENT.split('2. Tier 3 File Change Detection & ADR Enforcement')[1]?.split('3. Verify Branch Protection & No Self-Bypass')[0] || '';
  assert.match(step2, /ls docs\/adr\/\*"\$ADR_NUM"\*\.md/, 'Must verify cited ADR file exists in docs/adr/');
  assert.match(step2, /Cited ADR \(\$CITED_ADR\) not found in docs\/adr\//, 'Must report error if cited ADR does not exist');
});

test('hitl-pr-gate.yml blocks direct bot pushes to protected branches without PR merge', () => {
  const step3 = HITL_CONTENT.split('3. Verify Branch Protection & No Self-Bypass')[1] || '';
  assert.match(step3, /Merge pull request #\[0-9\]\+\|\\\(#\[0-9\]\+\\\)/, 'Must check for governed PR merge commit');
  assert.match(step3, /Self-Bypass Blocked: Automated actor cannot push directly/, 'Must block direct bot push without PR merge');
});

test('ci.yml triggers on PRs to both main and develop', () => {
  assert.match(CI_CONTENT, /pull_request:\s*\n\s*branches:\s*\[main,\s*develop\]/, 'ci.yml must trigger on PRs to main, develop');
});

test('cd-watchdog.yml supports JIRA secret aliases and checks JIRA_EMAIL', () => {
  const watchdogPath = path.join(REPO_ROOT, '.github/workflows/cd-watchdog.yml');
  const watchdogContent = fs.readFileSync(watchdogPath, 'utf8');
  assert.match(watchdogContent, /JIRA_CI_TOKEN: \${{ secrets\.JIRA_CI_TOKEN \|\| secrets\.JIRA_API_TOKEN/, 'Must support JIRA_API_TOKEN');
  assert.match(watchdogContent, /JIRA_EMAIL: \${{ vars\.JIRA_ACCOUNT_EMAIL \|\| vars\.JIRA_EMAIL/, 'Must support JIRA_EMAIL aliases');
  assert.match(watchdogContent, /if \[ -z "\$JIRA_EMAIL" \]/, 'Must check JIRA_EMAIL before curl');
  assert.match(watchdogContent, /grep -ioE 'KAN-\[0-9\]\+'/, 'Must match case-insensitive ticket key in multiline commit');
});

test('cd.yml supports secret fallback aliases for worker secrets', () => {
  const cdPath = path.join(REPO_ROOT, '.github/workflows/cd.yml');
  const cdContent = fs.readFileSync(cdPath, 'utf8');
  assert.match(cdContent, /GH_BRIDGE_AUTH_TOKEN: \${{ secrets\.BRIDGE_AUTH_TOKEN \|\| secrets\.BRIDGE_SECRET/, 'cd.yml must support BRIDGE_SECRET fallback');
  assert.match(cdContent, /GH_CLIENT_TOKEN: \${{ secrets\.CLIENT_API_KEY \|\| secrets\.CLIENT_API_TOKEN/, 'cd.yml must support CLIENT_API_TOKEN fallback');
});

test('validate-workflows.py detects unquoted ! in workflow if-conditions', () => {
  const scriptPath = path.join(REPO_ROOT, 'scripts/validate-workflows.py');
  const scriptContent = fs.readFileSync(scriptPath, 'utf8');
  assert.match(
    scriptContent,
    /cond\.startswith\(["']!["']\)/,
    'validate-workflows.py must check for unquoted !'
  );
});



