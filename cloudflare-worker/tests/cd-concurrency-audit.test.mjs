// Config audit for the CD deploy/gate machinery (KAN-173, KAN-174).
//
// Two production incidents in this repo had the same shape: the deploy
// pipeline silently stopped doing its one job while every green signal
// around it stayed green. KAN-173: a run left 'waiting' at the production
// approval gate held the cd-deploy concurrency lock for ~1.5 days, and every
// later deploy queued behind it as pending with zero jobs. KAN-174: GitHub
// gives no native notification for a pending approval, so a gate stall is
// invisible until someone opens the Actions tab.
//
// The fixes are configuration, and configuration regresses silently — a
// well-meaning edit to cd.yml can reintroduce the deadlock with no test
// failing, because no functional test exercises the scheduler. So this file
// reads the workflow sources the way the other governance tests read sources:
// the invariant is written down once, here, and CI enforces it on every push.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const CD = fs.readFileSync(
  new URL('../../.github/workflows/cd.yml', import.meta.url),
  'utf8'
);

const WATCHDOG = fs.readFileSync(
  new URL('../../.github/workflows/cd-watchdog.yml', import.meta.url),
  'utf8'
);

test('cd.yml keeps the deploy lock latest-wins (KAN-173 deadlock cannot return)', () => {
  const block = /concurrency:\n(?:[ \t]+#[^\n]*\n)*[ \t]+group: cd-deploy-\$\{\{ github\.ref \}\}\n[ \t]+cancel-in-progress: (true|false)\n/.exec(CD);
  assert.ok(block, 'cd.yml must declare the cd-deploy concurrency group');
  assert.equal(
    block[1],
    'true',
    'cancel-in-progress must stay true: with false, a run waiting at the ' +
      'production gate holds the lock forever and every later deploy queues ' +
      'behind it as pending with zero jobs (the KAN-173 incident)'
  );
});

test('cd.yml keeps the production gate on the deploy job (no unattended deploys)', () => {
  // deploy-production is the last job in cd.yml, so the job body runs to the
  // next column-0 key or EOF; the lazy match stops at either.
  const job = /deploy-production:\n[\s\S]*?(?=\n[a-zA-Z-]+:|$)/.exec(CD);
  assert.ok(job, 'cd.yml must keep a deploy-production job');
  assert.match(
    job[0],
    /environment:\s*\n\s+name: production/,
    'deploy-production must reference the gated production environment; ' +
      'without it GitHub starts the deploy unattended (the deleted staging ' +
      'job did exactly that)'
  );
});

test('cd-watchdog exists, is scheduled, and can file issues', () => {
  assert.match(WATCHDOG, /name: CD Watchdog/);
  assert.match(WATCHDOG, /schedule:/, 'the watchdog must run on a schedule — a dispatch-only watchdog is only as attentive as the human who remembers to click it');
  assert.match(WATCHDOG, /issues: write/, 'the watchdog files its stall issue with the workflow token');
  assert.match(WATCHDOG, /actions: read/, 'the watchdog reads run state via the Actions API');
});

test('cd-watchdog alerts on gate-waiting runs and closes the loop when healthy', () => {
  // The detector must key on the status GitHub reports while a required
  // reviewer holds the job, and on the CD workflow by name.
  assert.match(WATCHDOG, /status=waiting/, 'the scan must query waiting runs');
  assert.match(WATCHDOG, /select\(\.name == "CD — Deploy & Secret Sync"\)/, 'the scan must target the CD workflow by name');
  // The two halves of the autonomous loop.
  assert.match(WATCHDOG, /Fail loudly on a stall/, 'a stall must turn the check red — a silent watchdog is the same as none');
  assert.match(WATCHDOG, /Close the stall issue when healthy/, 'the stall issue must auto-close on resolution');
});

test('cd-watchdog never auto-approves the production gate', () => {
  // The reviewer gate is a deliberate human control (cd.yml's own comments
  // record how an unattended deploy once shipped production twice). The
  // watchdog's job is visibility, so it must not carry an approval call.
  assert.doesNotMatch(
    WATCHDOG,
    /"state"\s*:\s*"approved"|state=approved/,
    'the watchdog must not contain a gate-approval call — remediation is alerting, never bypassing'
  );
});

test('the CD stall runbook exists alongside the automation', () => {
  const runbook = fs.existsSync(
    new URL('../../docs/CD-STALL-RUNBOOK.md', import.meta.url)
  );
  assert.ok(
    runbook,
    'docs/CD-STALL-RUNBOOK.md must exist: an alert that fires with no documented response is a dead end'
  );
});
