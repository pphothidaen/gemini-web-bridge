# CD Stall Runbook

> **When:** the CD Watchdog fires (`CD STALLED` issue / red `CD Watchdog` run),
> or a deploy is visibly not shipping and `gh run list --workflow "CD — Deploy & Secret Sync"`
> shows a run parked on `waiting`.
>
> **Why this can happen at all:** the production deploy job is gated on a
> required reviewer (`environment: production`), and GitHub sends no
> notification while a run waits. The watchdog (`.github/workflows/cd-watchdog.yml`,
> KAN-174) turns that silence into a red X plus an issue within ~2 hours.
> The concurrency group is latest-wins (`cancel-in-progress: true`, KAN-173),
> so a stalled run can no longer block later deploys — the residual risk is
> only that **the newest deploy itself never ships** until a human acts.

## Decide first: should this run deploy?

Open the stalled run and read its head commit (`head_sha` → commit subject).
The watchdog links the run and states how long it has waited.

- **Yes** → approve (below). Do not approve blindly: confirm the subject and
  that CI on that commit was green.
- **No** (stale, superseded, wrong commit) → reject (below), then push or
  dispatch a fresh run so the intended code actually deploys.

## Approve the gate

```bash
RUN_ID=<the stalled run id>

# 1. Find the pending deployment and its environment id
gh api repos/pphothidaen/gemini-web-bridge/actions/runs/$RUN_ID/pending_deployments \
  --jq '.[0] | {environment_id: .environment.id, environment: .environment.name, can_approve: .current_user_can_approve}'

# 2. Approve (environment_ids must be a JSON number, not a string)
printf '{"environment_ids":[<ENV_ID>],"state":"approved"}' | \
  gh api -X POST repos/pphothidaen/gemini-web-bridge/actions/runs/$RUN_ID/pending_deployments --input -

# 3. Watch it finish
gh run watch $RUN_ID --repo pphothidaen/gemini-web-bridge --exit-status
```

## Reject the gate

Same call with `"state":"rejected"` and a comment; the run ends as
`deployment_rejected`, the watchdog issue closes itself on the next sweep, and
a fresh run carries the intended code.

## If the watchdog itself is the problem

- A red `CD Watchdog` run with **no** `CD STALLED` issue → the watchdog's own
  scan broke; read its `Scan for CD runs waiting past the threshold` step.
- Suspect the fix regressed → `npm test -- cd-concurrency-audit` in
  `cloudflare-worker/` pins `cancel-in-progress: true`, the gated job, and
  that the watchdog cannot auto-approve.

## History (why this file exists)

- **KAN-173** — with `cancel-in-progress: false`, a run waiting at the gate
  held the deploy lock ~1.5 days; every later deploy queued as pending with
  zero jobs. Fixed to latest-wins.
- **KAN-174** — GitHub never notifies about pending approvals; the watchdog
  closes that gap. Remediation is visibility, never auto-approval — the
  reviewer gate is a deliberate human control (cd.yml records how an
  unattended deploy once shipped production twice).
