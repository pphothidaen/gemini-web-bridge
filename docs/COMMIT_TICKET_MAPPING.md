# Commit → Ticket Mapping (Known Citation Mismatches)

> **Status:** authoritative reference. The `KAN-` prefix in the commit subjects
> listed below is **not** reliable — check this table before acting on a ticket.
> **Recorded:** 2026-09-27 · **Tickets:** [KAN-157](https://pansakorn.atlassian.net/browse/KAN-157)

Six commits at the tip of `main` carry a `KAN-` key that does not match the work
they describe. The messages are **left unchanged on purpose**; see
[Why not rewrite](#why-not-rewrite).

## The mismatches

| Commit | Cites | Actually is | Correct ticket |
|---|---|---|---|
| `09ade78` | KAN-156 | test: assert the 409 over HTTP, since WebSocket cannot report it | **KAN-157** |
| `c802a44` | KAN-156 | test: fix the last two unreachable handshake assertions in TS-012 | **KAN-157** |
| `51bc63e` | KAN-156 | fix(ci): the health probe could not run at all — no checkout | **KAN-157** |
| `fa97a5d` | KAN-157 | chore(deploy): migrate production to the Gemini.web.bridge Cloudflare account | *none* |
| `1b58bbc` | KAN-157 | fix(verify): repoint live MCP verification to the new production host | *none* |
| `55901d8` | KAN-157 | docs(verify): record the account-migration cutover evidence | *none* |

## Why the keys are wrong

- **`KAN-157` was predicted, never issued** when the migration commits were
  written. It has since been created for the test-harness work, so those three
  commits now point at an unrelated (if valid) ticket.
- **`KAN-156` is real but differently scoped** — it covers the extension build
  pipeline and deploy workflow, not WebSocket handshake assertions. It had been
  used as a catch-all key for unrelated commits.

## Why not rewrite

Correcting the subjects requires `git rebase` + **force-push** on `main`. That was
assessed and rejected:

- `main` has **no branch protection** (`branches/main/protection` → 404), so a
  bad rewrite has no safety net.
- The history has **three contributors** (70 `kimlenglim`, 6 `Pansakorn Phothadaen`,
  6 `Pphothidaen`) with merged PRs `#4`/`#5` (KAN-127, KAN-128). Rewriting changes
  the SHAs of commits they authored.
- **50 of 82 commits** on `main` cite a `KAN-` key, so a full cleanup reaches far
  beyond the six commits at issue.
- Release tag `v4.4.3` points into the affected range.

Relabelling a commit subject is not worth that blast radius. This file is the
correction instead.

## Tickets as closed

| Ticket | Label | Status | Fix landed in |
|---|---|---|---|
| [KAN-155](https://pansakorn.atlassian.net/browse/KAN-155) | `agent-developer_core` | Done | `d342beb` |
| [KAN-156](https://pansakorn.atlassian.net/browse/KAN-156) | `agent-devops` | Done | `51bc63e` + others |
| [KAN-157](https://pansakorn.atlassian.net/browse/KAN-157) | `agent-hermes` | Done | `09ade78`, `c802a44`, `dc582c6` |
| [KAN-159](https://pansakorn.atlassian.net/browse/KAN-159) | `agent-hermes` | Done | `4d80260` + KAN-162 + `b2e046a` |
| [KAN-160](https://pansakorn.atlassian.net/browse/KAN-160) | `agent-developer_core` | Done | `2da4d11` |
| [KAN-170](https://pansakorn.atlassian.net/browse/KAN-170) | `agent-hermes` | Done | `b2e046a` |
| [KAN-169](https://pansakorn.atlassian.net/browse/KAN-169) | `agent-hermes` | Done (duplicate) | *none — stub* |
| [KAN-173](https://pansakorn.atlassian.net/browse/KAN-173) | `agent-devops` | Done | `51c532a` |
| [KAN-174](https://pansakorn.atlassian.net/browse/KAN-174) | `agent-devops` | Done | `6ae487f` |

- **KAN-155** — the extension's direct-WebSocket fallback now sends `instanceId`
  (the DO rejects an upgrade without a UUID `instanceId`), and the `onerror` handler
  unwraps `ErrorEvent.message` so the cause is visible instead of `[object Event]`.
- **KAN-156** — four pipeline/deploy defects: versions never advanced, the "staging"
  job actually deployed production, mis-scoped Doppler tokens gave misleading
  errors, and the governance hook blocked `git revert`.
- **KAN-157** — WebSocket handshake assertions could never pass (close code 1006
  carries no HTTP status) and the suite flaked on single-instance lease ordering.
- **KAN-159** — the reported symptom (healthy idle connection dropped on a ~120 s
  cycle) took three landed fixes: `4d80260`, the KAN-162 threshold raise, and
  `b2e046a` (KAN-170) after production proved the residual cycle was Chrome
  tearing down the idle MV3 service worker between DO PINGs. Verified closed on
  production 2026-09-28: epoch stable, `lastActivityAt` advancing in 20 s steps.
- **KAN-160** — the orphaned-tab reload hint now reloads the page instead of
  retrying a connection that can never succeed.
- **KAN-170** — the `KAN-170` key was cited in `b2e046a` **before any ticket
  existed** (the same predicted-key failure mode as KAN-157 above); the ticket
  was created after the fact on 2026-09-28 and landed with that exact number, so
  the citation is now correct. See the `CLIENT_KEEPALIVE_INTERVAL_MS` heartbeat.
- **KAN-169** — an empty stub (summary was literally `KAN-105`, no
  description) citing the GOV-001 governance rule. Creator-confirmed duplicate
  of KAN-163, which completed that scope. Closed as Done/duplicate.
- **KAN-173** — CD deadlock: with `cancel-in-progress: false`, a run left
  waiting at the production approval gate held the `cd-deploy` lock for
  ~1.5 days and every later deploy queued behind it as pending with zero jobs.
  Fixed to latest-wins in `51c532a` and verified by a real two-run test
  (run A parked at the gate, run B superseded and cancelled it, B approved and
  deployed at HEAD).
- **KAN-174** — GitHub never notifies about pending approvals, so the residual
  failure mode was a deploy sitting at the gate unnoticed. `6ae487f` added the
  CD Watchdog (detect → loud failure → idempotent issue → Jira alert →
  auto-close on resolution), pinned by `cd-concurrency-audit.test.mjs` and
  verified end-to-end against a real gate stall. See `docs/CD-STALL-RUNBOOK.md`.

## Rule going forward

Before citing a `KAN-` key in a commit message, **confirm the issue exists and
that its scope matches the change**:

```bash
twg jira workitem get KAN-<id>     # must exist; read the summary before citing
```

Since KAN-163, the pre-push hook enforces the existence half of that rule
automatically: every `KAN-<id>` in the subjects being pushed is checked against
Jira, and the push is rejected if the ticket does not exist (see
`.githooks/pre-push`). It fails open when `twg` is missing or unreachable — a
wrong answer and no answer are different failures — so the scope half still
needs pre-commit diligence. KAN-170 was created after this hook was written,
not by it; the hook exists so the next predicted key is caught at push time,
not in a post-hoc audit.
