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

- **KAN-155** — the extension's direct-WebSocket fallback now sends `instanceId`
  (the DO rejects an upgrade without a UUID `instanceId`), and the `onerror` handler
  unwraps `ErrorEvent.message` so the cause is visible instead of `[object Event]`.
- **KAN-156** — four pipeline/deploy defects: versions never advanced, the "staging"
  job actually deployed production, mis-scoped Doppler tokens gave misleading
  errors, and the governance hook blocked `git revert`.
- **KAN-157** — WebSocket handshake assertions could never pass (close code 1006
  carries no HTTP status) and the suite flaked on single-instance lease ordering.

## Rule going forward

Before citing a `KAN-` key in a commit message, **confirm the issue exists and
that its scope matches the change**:

```bash
twg jira workitem get KAN-<id>     # must exist; read the summary before citing
```

A key that was never issued is silently accepted by the commit-msg hook, so the
hook cannot catch this class of error — only pre-commit diligence can.
