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
