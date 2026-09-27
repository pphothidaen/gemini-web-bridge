# ✅ E2E Verification — Extension → Worker → Gemini

> **Purpose:** Evidence that a real browser session can drive production end to end, plus the two traps that make a *false negative* out of a healthy system.
> **Verified:** 2026-09-27 · worker `v4.4.3` · deploy `ff26fa66-2445-401c-b28d-bd5d5b4b3d0d` · `main` `51bc63e`
> **Host:** `https://gemini-web-bridge.pansakorn-pho.workers.dev`

---

## Results

| # | Check | Method | Result |
|---|---|---|---|
| E2E-01 | `/health` reachable | `curl /health` | ✅ 200 · `status: ok` |
| E2E-02 | Bridge handshake | `/bridge/auth-check` + live WS | ✅ `{"ok":true,"protocolVersion":3}` · `CONNECTED_AND_READY` |
| E2E-03 | Extension instance identity | `/health.instance_tracking.connections[0].instanceId` | ✅ `f466376c-…` · epoch 1 · 1 conn · not stale |
| E2E-04 | Model catalog is live | `GET /v1/models` | ✅ 3 verified models, `gemini-3.8-flash` default |
| E2E-05 | **Real generation (non-stream)** | `POST /v1/chat/completions` | ✅ 200 in **5.8s** → `BRIDGE_OK 42` |
| E2E-06 | **Real generation (SSE)** | `stream:true` | ✅ 3 chunks + `[DONE]` |
| E2E-07 | MCP tool discovery | `POST /mcp` `tools/list` | ✅ 9 tools |
| E2E-08 | MCP cheap tool | `tools/call check_bridge_health` / `ping` | ✅ both returned live state |
| E2E-09 | MCP real generation | `tools/call code_review_and_debug` | ✅ correct root-cause analysis returned |
| E2E-10 | Argument validation | wrong param name | ✅ `-32602` naming the required arg |
| E2E-11 | Health probe under load | `workflow_dispatch` on keepalive-probe.yml | ✅ green · `CONNECTED_AND_READY` · 1 conn |
| E2E-12 | No error accumulation | `/health.health_metrics` | ✅ `consecutive_errors: 0` · `last_error: null` |
| E2E-13 | Sustained generation, ~30 s apart | 10 × `POST /v1/chat/completions` | ✅ **10/10 HTTP 200** |
| E2E-14 | Scheduled probe round (`17 */6 * * *`) | run `36300734260` | ✅ green · `CONNECTED_AND_READY` · 1 conn |

---

## ⚠️ Trap 1 — the extension bundle is a build artifact, and it goes stale silently

`dist/extension/` and `release/gemini-bridge-vX.Y.Z/` are **gitignored**. Nothing
in CI rebuilds or freshness-checks them, so they can lag behind
`extension-cloudflare/` indefinitely while every test still passes.

Found here: `release/gemini-bridge-v4.4.3/` had been built at 22:24, *before*
`d342beb` (KAN-155) landed at 01:29. That commit fixed the direct-WS fallback
path, which sent no `instanceId` and was therefore rejected by the hub with
`401 "Unauthorized: Invalid instance ID"` — the commit notes it as a path that
"could never connect".

**Testing that bundle would have reproduced a bug that was already fixed, and
blamed production for it.** `dist/` was additionally at `4.4.6` against a
`4.4.3` worker.

**Always rebuild before loading unpacked:**
```bash
python3 scripts/build-extension.py --set-version <v> --create-zip
# chrome://extensions → Load unpacked → dist/extension
```
Use `--set-version` with the *current* manifest version. `--bump-version`
rewrites `extension-cloudflare/manifest.json` and breaks
`tests/version-consistency.test.mjs`.

---

## ⚠️ Trap 2 — `DISCONNECTED` usually means "no Gemini tab", not "broken"

The content script only runs on `https://gemini.google.com/*`, so the bridge
cannot connect until such a tab exists. A worker with nothing open reports
`extension_status: "DISCONNECTED"` and `GET /v1/models` returns
`data: []` with `status: "disconnected"` — **both are normal**, not faults.

Distinguishing signal: a real connection bumps `instance_tracking.epoch_counter`
and changes `catalog_revision`. A `DISCONNECTED` worker whose epoch is still
moving means clients *are* arriving and dropping; an epoch frozen at 0 means
nothing ever tried.

**Confirming a live connection:** open a Gemini tab, then expect
`CONNECTED_AND_READY`, `active_connections_count: 1`, and a populated `data[]`.

---

## Probe semantics (settles the "will it alert?" question)

`keepalive-probe.yml` fails **only** when `/health` returns non-200. A
disconnected extension still returns 200, and the extension-presence step is
advisory (`|| true`). So **the probe will not fail when the extension is
disconnected — by design.** It exists to catch 1101 / DO exhaustion, not

---

## 🔁 Production account migration — 2026-09-27

Production moved from one Cloudflare account to another. The bridge itself was
not changed; the *location* was.

| | Before | After |
|---|---|---|
| Account | `f1409612…` (Pansakorn.pho@gmail.com) | **`d91b1a43…` (Gemini.web.bridge@gmail.com)** |
| Worker name | `gemini-web-bridge` | **`prod`** |
| Hostname | `gemini-web-bridge.pansakorn-pho.workers.dev` | **`prod.gemini-web-bridge.workers.dev`** |
| KV namespace | `9620c1ac…` | **`400bc54565de455689ece92f8351bcb9`** |

The worker is named `prod` because a workers.dev hostname is
`<worker>.<subdomain>.workers.dev`; with the worker also named
`gemini-web-bridge` and the account subdomain `gemini-web-bridge`, the first
deploy produced the doubled, confusing
`gemini-web-bridge.gemini-web-bridge.workers.dev`.

`BRIDGE_AUTH_TOKEN` and `CLIENT_API_TOKEN` were re-created on the new worker
with **identical values**, so clients only needed a hostname change — no token
rotation, no re-issuing credentials to any consumer.

### What is account-scoped and had to be recreated

- **KV namespace.** A KV id is not valid across accounts. The old id is
  unreachable from the new account; a new namespace had to be created and both
  `cloudflare-worker/wrangler.toml` and `wrangler.jsonc` updated. Any artifact
  written under `ARTIFACT_KV` before the migration is still in the old account
  and will not be readable here.
- **Durable Object.** A new worker gets a fresh DO namespace, so all in-memory
  state (catalog, scope, queue, health metrics) starts empty. Expected on a
  migration, not a fault.
- **Workers secrets.** Re-uploaded with `wrangler secret put`.

### The pre-migration deployment is still live

`gemini-web-bridge.pansakorn-pho.workers.dev` continues to serve on the old
account and was deliberately left running as a rollback target. Anything still
configured against it keeps working until it is retired. The old account's
token and account id are kept, commented, in both `.env` files for that reason.

### Two things that would have bitten silently

**Local deploys could land in the wrong account.** `CLOUDFLARE_ACCOUNT_ID` was
absent from the root `.env`, so `wrangler` fell back to this machine's OAuth
session — which still pointed at the old account. A `wrangler deploy` would
have reported success while publishing to the account nobody was looking at. It
is now set explicitly in both `.env` files, with a comment saying why.

**GitHub secrets had to change before the push, not after.** `cd.yml` deploys on
any push touching `cloudflare-worker/**`, `extension-cloudflare/**` or
`scripts/build-extension.py` — which this migration touches in all three. With
the old `CLOUDFLARE_ACCOUNT_ID` still in the repository secrets, the first push
would have deployed a worker named `prod` into the old account. `secrets.CLOUDFLARE_ACCOUNT_ID`
and `secrets.CLOUDFLARE_API_TOKEN` were updated *before* committing.

Note there were no repository variables or secrets shadowing the new hostnames:
`vars.PROD_BASE_URL` and `secrets.WORKER_URL` / `secrets.MCP_ENDPOINT` do not
exist, so the updated defaults in the workflow files are what actually take
effect. Worth re-checking if those are ever added, because they would silently
override the in-repo values.
absence of a browser. Absence is recorded, not raised, deliberately: failing on
it overnight would train everyone to ignore the workflow.

---

## 🔴 Connection churn, and one outage that `/health` cannot see

Two separate things, measured rather than assumed. The first is normal; the
second is a real blind spot.

### 1. The WebSocket silently recycles every ~2 minutes (normal)

Polling `/health` every 20 s for 6.7 minutes, idle traffic:

```
06:40:14  epoch=1 conns=1 idle=0
06:41:34  epoch=1 conns=1 idle=49   stale=True
06:42:15  epoch=1 conns=1 idle=89   stale=True
06:42:35  epoch=2 conns=1 idle=16   stale=False   <-- reconnect, same instanceId
06:43:56  epoch=2 conns=1 idle=97   stale=True
```

`epoch_counter` increments (a new socket with the same `instanceId`), and
`idleSeconds` climbs past the 45 s stale threshold because the extension does not
answer the DO's keepalive ping while suspended.

**This cycle is invisible from outside:** `extension_status` read
`CONNECTED_AND_READY` and `active_connections_count` read `1` in **20 of 20**
samples. There is no observable gap.

Under continuous traffic the churn disappears entirely — 10 generations at ~30 s
intervals, **10/10 HTTP 200**. Real traffic keeps the socket warm, so the cycle
only appears when the bridge is genuinely idle.

### 2. A ~6 minute outage where nothing retried (once observed)

Earlier the same day, 06:32–06:38Z: `extension_status: DISCONNECTED`,
`epoch_counter` reset to `0`, and generation returned
`503 extension_disconnected` after ~12 s. `wrangler tail` showed **zero**
WebSocket upgrade attempts to `/bridge` — not failing, never trying. Every
recovery path in `background.js` was given a chance and none fired:

| Recovery attempt | Window | Result |
|---|---|---|
| `chrome.alarms` `bridge-keepalive` → `checkStaleSocket()` | 95 s | no attempt |
| Reload the Gemini page | 60 s | no attempt |
| Bring the tab to the foreground | 60 s | no attempt |
| Cross-origin navigation away and back | 60 s | no attempt |

The content script stayed healthy throughout (leader granted, `READY`, 5 s
heartbeat), so this is the **background service worker**, not the page. It
later recovered by itself with the same `instanceId`.

Leading hypothesis: MV3 terminates the worker ~30 s after the last WebSocket
frame; the in-memory `_state` dies with it. `connect()` short-circuits on
`AUTH_FAILED` (background.js:362), and the comment at background.js:396-398
warns a missing `?instanceId=` yields a 401 that "permanently locks out
reconnection". Separating "the alarm never fires" from "the worker restarts and
refuses to retry" needs the service worker's own console, which a page-level log
cannot reach.

### The blind spot, which matters more than either

During the 06:32–06:38Z outage, `/health` reported
`consecutive_errors: 0` and `last_error: null` **while generation was returning
503**. The 503 is classed as an expected "no browser attached" state, so no
error counter ever moves.

So neither signal can distinguish the two failure modes:

| State | `/health` | probe | generation |
|---|---|---|---|
| Nobody's home | 200 `DISCONNECTED` | green | 503 |
| Worker wedged | 200 `DISCONNECTED` | green | 503 |
| Healthy idle | 200 `CONNECTED_AND_READY`, `isStale: true` | green | 200 |

All three look identical to monitoring. If the DO's own keepalive ever stops
being answered *and* no reconnect follows, nothing in this repo will notice.
The cheap improvement is to make the DO's alarm distinguish "no client" from
"client that stopped answering" and surface that as a distinct signal, rather
than widening the probe to fail on `DISCONNECTED` — that state is legitimately
common overnight and would cry wolf every night.
