# KAN-236: latency vs conversation-context length — measured 2026-10-02

Method: 4 turns in one fresh `/app` conversation (`c_c3803f19a83c47c5`),
prompts typed via Kapture, `StreamGenerate` requests captured with Kapture
network monitoring. Context block = the opaque field at inner index `[3]`
of `f.req`; its encoded byte length was measured exactly for turn 1 and
derived for turns 2–4 from `requestBodySize` minus the (constant) session
scaffolding and the URL-encoded prompt. Duration = XHR `durationMs`
(request start → stream complete). `gfet` = `server-timing gfet4t7`
(backend generation fetch), which excludes client streaming time.

| turn | context block (B, url-encoded) | duration (ms) | server-timing gfet (ms) |
| ---: | ---: | ---: | ---: |
| 1 | 1740 | 2286 | 656 |
| 2 | 2047 | 3037 | 1903 |
| 3 | 2223 | 3616 | 2409 |
| 4 | 2432 | 3331 | 1874 |

Pearson r: context vs duration = **0.87**; context vs backend gfet = **0.78**.

Reading: latency grows with conversation length, and the growth shows up in
the backend `gfet` timing, not only in the streamed response — so it is
server-side context processing, not client rendering.

Caveats: n=4, one run, same model (3.5 Flash-Lite per response metadata),
answer lengths were not equalized (turn 4 asked about two planets), and
turns 2–4 context lengths are derived (turn 1 measured exactly; scaffolding
assumed constant within the page session — `at`/`f.sid` unchanged).

## Addendum 2026-10-02 (controlled run — incomplete, and why)

Attempted the controlled rerun: identical question each turn
(`ตอบว่า "ว่าง" เพียงคำเดียวเท่านั้น ห้ามมีคำอื่นนอกจากนี้`, 56 chars) so answer
length is pinned and context is the only variable.

Partial result, in a fresh conversation `b216bb1615025722`:

| turn | context block [3] | StreamGenerate durationMs |
|---:|---:|---:|
| 1 | — | 2286 |
| 2 | **2685** | not captured |

**Not completed, and the blocker is tooling cost rather than method.**

Two findings for whoever finishes it:

1. `kapture__network_monitor` buffers everything. Left on for a whole session it
   held **566 requests**, almost all analytics and cached script loads, and
   `network_requests` has no URL filter — reading it costs enormous context for
   one StreamGenerate row. **Enable monitoring per-turn, read, disable.** The
   buffer then stays at a handful of entries and the StreamGenerate rows are
   cheap to find.

2. `last_successful_generation` on `/health` is **not** a usable completion signal
   for Kapture-driven sends. It stayed `null` through a completed turn, because it
   only advances for bridge-initiated generations (horo_consult). Do not build a
   timing loop on it.

The capture side is fine and needs no fix: `at` gives the request fire time and
`[3]` gives context length, both exact, with `extensionVersion` proving the
producer build.

Remaining shape: 5+ turns, per-turn monitoring, one identical pinned-length
question. The current n=4 uncontrolled run is not enough to separate "scales
with context" from "scales with answer length", which is the whole point of the
rerun.

### Second attempt (same day) — network-based timing abandoned

Tried the per-turn monitoring fix from the addendum above. It does not solve it.

With the buffer force-cleared and monitoring re-enabled immediately before a
single send, the buffer reached **57 entries in about 20 seconds**. Google emits
roughly three `play.google.com/log` calls plus a `google-analytics.com`
beacon per second from this page, and `network_requests` has no URL filter, so
extracting one StreamGenerate row means paying for every analytics row around it.
Per-turn monitoring reduces 566 entries to 57; it does not make the signal
readable.

**Do not spend further attempts on network-based timing.** It is a tooling
dead end here, not a methodology problem.

### The viable path, for whoever has context budget

The capture channel already yields two of the three numbers per turn, exactly and
with the producer build attached:

- request fire time  → `captures[].at`
- context length     → `structure[3].length`

Only completion time is missing, and `/health` `last_successful_generation` will
not supply it — it stays `null` for Kapture-driven sends because it only
advances for bridge-initiated generations.

Cheapest workable loop, about four tool calls per turn and no network buffer:

1. `POST /debug/payload-capture {"armed":true}` — after any navigation.
2. Send the pinned-length message via Kapture.
3. One `kapture__elements` on `model-response` to see the turn has rendered.
4. `python3 -c "import time;print(int(time.time()*1000))"` for completion.

latency = (3) − `captures[].at`.

Note `date +%s%3N` does not work on macOS — it is GNU-only and silently emits
`N`. Use python for millisecond timestamps.

### Third attempt — the bottleneck is structural, not tooling

Tried using `/health` `collection.last_progress_at` as the completion signal,
which would have made the whole measurement two tool calls per turn and needed
no network buffer at all. It does not work, and the reason closes the door on
this approach.

**`COLLECT_ANSWER_PROGRESS` is only emitted from `content.js` `handleCollectAnswer`**
— the handler the WORKER invokes when it orchestrates a turn. A message typed and
sent through Kapture never enters that path, so it produces no heartbeat at all.
`last_progress_at` therefore stays frozen at whatever the last *bridge-driven*
turn left behind, which is why the estimator produced negative latencies
(`(stale - fire)`), not merely noisy ones.

Two further traps found on the way:

- **Hidden tabs get timer-throttled by Chrome.** With the tab in the background
  the 3 s heartbeat interval is suppressed, so even for a bridge-driven turn the
  signal dries up. `kapture__show` before sending, or the instrument lies.
- **Fixed waits produce a floor, not a measurement.** A 22 s wait against a ~5 s
  response reports 22 s, and every turn reads the same, so r comes out at zero
  from a run that looks perfectly orderly.

**Net: for out-of-band sends there is no cheap completion signal.** The capture
gives request fire time and context length exactly; the only remaining signal is
polling `model-response`, at roughly one tool call per 3 s. That is the only
method that yields trustworthy per-turn latency here, and it is expensive.

Recommendation: do not attempt this again through Kapture. If per-turn latency
matters, measure it in the bridge itself — `executeThroughExtension` already has
the duration wrapper that was added for exactly this, and now that `vlog` reads
`env` it will actually emit. Driving turns through `horo_consult` makes the
measurement a by-product of normal traffic instead of a separate experiment.
