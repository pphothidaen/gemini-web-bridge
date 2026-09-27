# HANDOFF — DO alarm never fires (KAN-168)

Written 2026-09-27, immediately after the instrumentation run.

**Read this first.** Everything below is measured, not inferred, except where a
line says *unproven*. The previous session's core mistake was repeatedly
concluding a root cause from circumstantial evidence and acting on it. This
document separates the two categories deliberately so the next session does not
repeat that.

## The bug

The Durable Object's alarm never fires. Consequently three things silently do
not run on production:

- the keepalive PING is never sent to the extension
- the stale-socket sweep never runs
- the MCP SSE `: keepalive` comment is never written

Symptoms measured on 2026-09-27:

- a connection sat at `idle=209s` against a 180s stale threshold and was never
  reaped
- `idle` climbed 234 → 248 → … → 423s monotonically, never resetting
- an MCP SSE stream ran 231s and received zero keepalives

## What is proven

**1. `ctx.alarm` is set successfully.** Instrumentation reads the property
back immediately after the write:

```
[Bridge DO] ALARM READBACK (once per instance):
  set ctx.alarm=120s (mode=idle); read back ctx.alarm=120 type=number
```

A number, not `null`/`undefined`. The assignment takes effect.

**2. `alarm()` is never called.** With `BRIDGE_VERBOSE=1` deployed, the alarm
was armed several times and produced:

```
scheduleAlarm(constructor):     armed in 120s (mode=idle, conns=0)
scheduleAlarm(generation-start): armed in 15s  (mode=busy, conns=1)  x2
scheduleAlarm(generation-end):   armed in 120s (mode=idle, conns=1)  x2
alarm() tick:  0
```

133 seconds after a 120s arm: zero invocations. `wrangler tail` shows zero
scheduled events (events with no request) across every capture.

**3. It is a single DO instance.** `durableObjectId` is
`9711524b8b715f56` for every event. Not a multi-instance or routing problem.

**4. The export shape is correct.**

```js
import { DurableObject } from "cloudflare:workers";
export class GeminiBridgeDO extends DurableObject
export default { async fetch } → env.BRIDGE_DO.idFromName("global-bridge")
```

**Conclusion:** the application arms the alarm correctly, the value persists,
and the runtime never delivers the callback. This is not an application-logic
bug and is not fixable in the current source.

## What is *not* proven — do not repeat these

Each of these was asserted from code-reading alone and each was wrong:

- **✗ "the alarm is skipped because `hasActiveWork` is false at the re-arm"**
  Plausible from reading `alarm()`, but nothing logged that branch. It may
  never be reached, because `alarm()` never runs.
- **✗ "`ctx.alarm` is never set"** — disproved by the read-back above.
- **✗ "the MCP keepalive count proves the alarm is dead"** — **weak probe.**
  `alarm()` only writes keepalives when `mcpSessions` is non-empty. The
  measurement opened an SSE stream with GET and never POSTed on that session,
  so it may never have been registered. Do not use this as evidence. Send a
  POST on the session first.

## Why this matters

The near-zero idle CPU currently measured (2 ms across 23 minutes) is a **side
effect of this bug**, not evidence of good tuning. Fixing the alarm will raise
idle CPU to roughly 360 CPU-ms/day (`docs/TUNING.md`) — that is correct
behaviour being restored, and still a rounding error against the ~1,000,000
ms/day free-tier budget.

Until it is fixed there is no liveness detection at all: a dead extension holds
its slot until something else evicts it.

## Suggested next steps, in order

1. **Reproduce in a controlled environment first.** Stand up a throwaway DO
   (`wrangler dev` or a staging worker) and confirm whether an alarm fires
   there at all. This is the step the previous session skipped, and it would
   likely have answered the question in minutes instead of four production
   deploys.

2. **Check the binding declaration.** `cloudflare-worker/wrangler.toml` declares:

   ```toml
   [durable_objects]
   bindings = [{ name = "BRIDGE_DO", class_name = "GeminiBridgeDO" }]
   migrations = [{ tag = "v1", new_sqlite_classes = ["GeminiBridgeDO"] }]
   ```

   Verify `class_name` matches the export exactly, and consider whether
   `new_sqlite_classes` (vs `new_classes`) interacts badly with alarms at this
   `compatibility_date` (2026-09-12).

3. **Try a minimal DO on the same account/plan.** If a trivial DO's alarm also
   never fires, this is environmental — account, plan, or platform — and the
   right move is to raise it with Cloudflare rather than keep editing source.

4. **Consider a fallback that does not depend on alarms.** The client already
   has its own reconnect path. A server-side fallback would be `setInterval`,
   which `docs/TUNING.md` explicitly rejects for burning the free tier — only
   worth it on a paid plan.

## Instrumentation currently in the tree

Remove these once the cause is known — both are marked `TEMPORARY` in source:

- `cloudflare-worker/src/index.js`, `scheduleAlarm()`: the `ALARM READBACK`
  `console.warn` (once per instance, ungated)
- the `scheduleAlarm(reason)` parameter and the `NOT re-arming` vlog branch

The arm-on-connect call added in `3352474` is **not** diagnostic — it is
correct defensive code (a connecting client should re-arm the cadence) and can
stay.

## Current production state

- worker deployed at `e4110404` (then `7b99455` for docs only)
- `extension_status: DISCONNECTED`, `conns: 0` — the user has not reloaded the
  extension since the KAN-166/167 builds shipped
- `BRIDGE_VERBOSE` is **off**, as the user asked

## Tooling notes

**Reading a service worker's console** — a SW runs in its own execution
context, so its logs never appear in a page's DevTools console.

```bash
node scripts/sw-console.mjs <port> <ext-id-substring> <seconds>
```

Chrome must be started with `--remote-debugging-port`. The script header
documents two traps that cost two production incidents:

1. Chrome 137+ ignores `--load-extension`, so a throwaway profile cannot be
   seeded with the extension from the command line.
2. Never run a second profile against a live production DO. Both extensions
   hold the same slot; the second is 409'd forever. That presents as a client
   that connects, gets evicted, and cannot recover — which reads as a reconnect
   bug and sends you into the extension instead of the server.

**`BRIDGE_VERBOSE=1`** (`wrangler deploy --var BRIDGE_VERBOSE:1`) un-gates
`vlog()`. **Turn it off when finished** — it re-enables 23 hot log sites and
costs real CPU. Prefer a targeted `console.warn` for one-off diagnostics.

**Atlassian MCP is available.** Site `pansakorn.atlassian.net`, cloudId
`45765a55-d652-421c-8096-940cebfd0bf7`, project `KAN`. Credentials in `.env`
(gitignored): `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_GEMINI_PASS_API_TOKEN`. Use
Basic auth with `JIRA_EMAIL`. The GitHub-side `JIRA_CI_TOKEN` secret and
`JIRA_ACCOUNT_EMAIL` variable may not be set; `ci.yml:445` skips the Jira sync
when they are missing, which is why no comments were auto-posted.

## Housekeeping

- History was rewritten once (Jira renumbering). Anyone with a clone must
  `git pull --force`. Pre-rewrite state is tagged `backup-before-jira-rewrite`.
- `scripts/chrome-dev-shortcut.command` and `scripts/chrome-dev-shortcut.app/`
  are untracked and belong to the user. Do not delete them.
- `.env` is gitignored. Never print token values — read them into a variable
  and use them, or check only the key's length and prefix.

## A note on process

Four production deploys went into this bug, and the first three were spent
confirming things that a single `wrangler dev` run would have shown. The
mistake was treating production as the place to test a hypothesis. When the
next question is "does X work at all in this environment", build the smallest
thing that answers it and run that first — the production DO is currently
without liveness detection, and every deploy to it is a real cost.
