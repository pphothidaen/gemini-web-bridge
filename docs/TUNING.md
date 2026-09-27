# Production Tuning Reference

Operational notes for keeping the Cloudflare Worker inside its CPU
budget. Written after the September 2026 outage, when the Durable Object
exhausted its free-tier allowance and every endpoint began returning
Cloudflare error 1101.

The one number that matters: **a free Workers plan allows roughly 1,000,000
CPU-milliseconds per day, and the Durable Object draws from the same
allowance as everything else.** Optimising this is not premature — it is
what keeps the bridge serving.

---

## Measured baseline

Captured with `wrangler tail` against production, not estimated:

| Endpoint | CPU per request |
|---|---|
| `GET /health` | 0.20 ms |
| `GET /v1/models` | 0.20 ms |
| `POST /v1/chat/completions` | 1.50 ms |

**Request traffic is not the problem.** At a realistic 200 generations
plus 2,000 status checks per day, that is ~700 CPU-ms — under 0.1% of
the daily budget. The always-on work was the cost, and it was the
Durable Object's timer.

A 65-second idle capture produced 15 invocations, 10 CPU-ms total, and
**zero scheduled events** — the DO is genuinely asleep when nothing is
connected.

---

## What the DO does on a timer

One alarm drives both keepalive and stale-socket cleanup. Its cadence is
chosen from actual state:

| State | Interval | Wakeups/day |
|---|---|---|
| Generation in flight, active stream, or queued request | 15 s | 5,760 |
| Connection merely held, nothing happening | 120 s | 720 |
| No connection | not rescheduled | **0** |

Constants live in `cloudflare-worker/src/index.js`:

```js
static STALE_SOCKET_IDLE_MS      = 180000;   // evict a dead socket after this
static RUN_ALARM_INTERVAL_MS     = 15000;   // fast cadence, work in flight
static IDLE_ALARM_INTERVAL_MS    = 120000;  // slow cadence, idle
```

### The invariant: stale threshold > alarm interval

`STALE_SOCKET_IDLE_MS` **must stay above `IDLE_ALARM_INTERVAL_MS` plus a
margin.** The keepalive only PINGs once per alarm tick, so a healthy but
idle connection is *always* past a threshold below ~120 s by the time the
sweep runs. A 45 s threshold against a 120 s alarm is not a conservative
setting — it is a contradiction: raw idle time cannot distinguish "quiet
but answering" from "dead", so live sockets were swept and the lease
flapped roughly every two minutes. This bit production on 2026-09-27
(`KAN-161`).

The margin is 60 s (180 − 120), which is what lets the raw-idle fallback
stay meaningful for connections the keepalive never got to probe.

**The trade-off, stated plainly.** With a 120 s alarm and a 180 s stale
threshold a dead socket is reaped after 180–300 s rather than 45–60 s.
Nothing user-visible depends on that latency:

- A dead socket produces no traffic either way.
- The 409 conflict guard on the upgrade path runs its own inline
  staleness check, so a reconnecting extension never waits on the alarm.
- The alarm is a memory-hygiene sweep, not a gate.

The alternative — PINGing every 15–30 s so a healthy connection could
answer inside a 45 s window — was rejected. It multiplies idle wakeups by
4–8× (720/day → 2,880–5,760/day) to buy latency that the point above
shows is not user-visible, and the DO is the exact component that
exhausted the free tier in the September outage. The threshold is the
cheaper side of that trade.

`tests/liveness.test.mjs` asserts this ordering directly, so a future
edit that inverts it fails CI instead of production.

### Do not remove the PING

`touchConnection()` fires only on an **inbound** message. That is what
makes the liveness detection work:

- Extension alive → answers `PONG` → `lastActivityAt` stays fresh → kept.
- Extension dead → no `PONG` → goes quiet → swept as stale.

If the PING is removed, staleness detection stops working entirely.

### Do not reintroduce `setInterval`

`85a370b` replaced `setInterval` with the native alarm API. `setInterval`
keeps the event loop alive, which prevents DO eviction and burns CPU
continuously — that was the original cause of the outage.

---

## MCP / SSE keepalive

The alarm also sends a `: keepalive` comment to every open MCP session so
proxies do not drop the stream. That write is **per session**, so N parked
clients meant N writes on every wakeup — and the streams most in need of
a keepalive are precisely the ones doing nothing.

Each session now records `lastWriteAt`, stamped both by the keepalive
loop and by real traffic in `sendSseMessage`. A session written within
the last 30 s is skipped.

```js
static MCP_KEEPALIVE_MIN_MS = 30000;
```

Writes per day with 5 parked clients:

| Alarm cadence | Before | After |
|---|---|---|
| 15 s (busy) | 28,800 | **14,400** |
| 120 s (idle) | 3,600 | 3,600 |

The idle row is unchanged by design: at a 120 s alarm there is never a
second fire inside the 30 s window, so nothing is suppressed. The floor
matters in the busy case, where the alarm fires twice inside 30 s and
the second write was pure waste.

30 s is chosen because typical proxies drop an idle SSE connection at
roughly 60 s — a longer floor would risk the connection, a shorter one
would buy nothing.

---

## Logging

`console.log` is not free in Workers: each call formats its arguments,
serialises them, and enqueues a log entry, all charged to the same
budget.

- **23 high-frequency sites** (per-connection, per-message, per-model-sync)
  now go through `vlog()`, a no-op unless `BRIDGE_VERBOSE=1`. That is
  every `console.log` in the file except the one inside `vlog` itself:
  **44 call sites -> 1.**
- **All 11 `console.warn` and 10 `console.error` sites are untouched.**
  They are rare and they are the diagnostic that matters when something
  is actually wrong. Gating those would trade a real signal for a
  millisecond.

To debug with full logging:

```bash
npx wrangler deploy --var BRIDGE_VERBOSE:1
# revert with:
npx wrangler deploy
```

Local run: `BRIDGE_VERBOSE=1 npx wrangler dev`

---

## Observability: off, deliberately

Both configs set `observability.enabled = false`
(`wrangler.jsonc` and `cloudflare-worker/wrangler.toml`).

Workers Logs retains an entry per invocation, charged against the same
CPU budget. Nothing in this repo consumed those logs — `wrangler tail`
provides the same events on demand, and the free plan has no metrics
API to scrape anyway. Turn it back on per account if a paid plan makes
the retention worth its cost.

---

## Monitoring

`.github/workflows/keepalive-probe.yml` probes `GET /health` every 6
hours and **fails loudly**, filing or updating a GitHub issue.

It exists because CI only touches production on a push. Between commits
an idle DO could burn its entire daily budget with nobody noticing —
which is exactly what happened.

`scripts/probe-production.py` classifies the response so the alert says
something actionable:

| Response | Meaning |
|---|---|
| `200` | healthy |
| body contains `1101` | **DO free-tier CPU exhausted.** Not a code regression. Raise the Workers plan. |
| `000` | unreachable or wedged |
| `503` | no usable model — normal when no extension is connected |
| other `5xx` | check `wrangler tail` and recent deploys |

Separating 1101 matters: it is a billing limit, and conflating it with
a generic 5xx sends whoever is on call to debug the wrong thing.

The extension-presence check is **advisory only** and never fails the
workflow. No connected extension is normal overnight and on weekends;
failing on it would train everyone to ignore the probe.

---

## Recommended: raise the plan

After all of the above, a permanently connected but idle bridge still
costs roughly 720 × ~0.5 ms ≈ **360 CPU-ms/day**. That is small, but it
is not zero, and the budget resets daily whether or not it is used.

**A Workers Paid plan is $5/month and raises the ceiling by ~30×.** For a
service whose failure mode is "customers get 500s", that is better value
than any further optimisation, because it removes the failure mode
instead of reducing its likelihood.

Optimisation buys headroom. The plan removes the cliff.

---

## Change log

| Commit | Change |
|---|---|
| `85a370b` | `setInterval` → native DO alarm. Removed the constant burn. |
| `af5ec4f` | Adaptive interval: 15 s busy, 60 s idle. Also fixed `scheduleAlarm` so it re-arms instead of no-op'ing when an alarm is already pending. |
| `e502a0e` | Idle interval 60 s → 120 s; 23 hot log sites gated behind `vlog()`; observability off. |
| `27d37f6` | 6-hourly production health probe, failing loudly and filing an issue. |
| `KAN-161` | Stale threshold 45 s → 180 s, restoring the invariant that it exceeds the 120 s idle alarm. Fixed the ~2-minute lease flap. Alarm cadence unchanged, so wakeups/day are unchanged. |
| this change | MCP SSE keepalive throttled per session to one write per 30 s. |
