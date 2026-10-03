# KAN-236: latency vs conversation-context length — measured 2026-10-02

## Continuation 2026-10-03 — increasing-history fixed-output comparison

Follow-up on the same authenticated Gemini UI, conversation, model
(`gemini-3.8-flash-lite`), and build
(`boq_gemini-web-uiserver_20261002.02_p0`). For each target turn, the prompt was
identical and rendered to the same 16-character answer. I increased prior
conversation history with neutral seed prompts. “Prior transcript chars” is the
visible rendered transcript length before the target turn, used as a proxy; it
is not the model's tokenized context length. Latency is from the captured
`StreamGenerate` request time until the target response appeared settled.

| prior visible transcript chars | target `f.req` field `[3]` chars | answer chars | latency (ms) |
|---:|---:|---:|---:|
| 0 | 2679 | 16 | 3683 |
| 3048 | 2679 | 16 | 3612 |
| 8143 | 2679 | 16 | 3194 |
| 18297 | 2679 | 16 | 3226 |
| 35397 | 1705 | 16 | 3098 |
| 69924 | 1705 | 16 | 4612 |

Across these six observations, latency ranged from 3.098 to 4.612 seconds and
did not increase monotonically with visible history. The captured field `[3]`
also did not track visible transcript size: it stayed at 2679 characters for
the first four observations, then measured 1705 for the last two. Do not treat
that field as a full context-length measure. The observations support only a
preliminary finding; six samples from one conversation and rendered character
counts cannot establish the causal effect of model context. Repeated paired
measurements and an independently validated context-size measure are needed for
a stronger conclusion.

## Continuation 2026-10-04 — foreground, same-chat pair

I repeated the fixed-output comparison in a visible Gemini tab, using the same
conversation for both target turns. The UI model selector showed `Flash`. The
first target had no prior rendered messages; then I sent a 10,400-character
neutral seed prompt and repeated the exact target prompt. The transcript before
the second target contained 10,672 rendered characters. Both target answers
rendered to 16 characters.

| prior visible transcript chars | answer chars | click-to-settled-response (ms) |
|---:|---:|---:|
| 0 | 16 | 3493 |
| 10672 | 16 | 4677 |

Chrome DevTools observed two `StreamGenerate` requests for the short-context
target (request durations 2036 and 2410 ms) and one for the longer-context
target (3106 ms). The request counts differ, so these network durations are not
a clean one-to-one pair. The UI completion time increased by 1.18 seconds in
this single pair. This is consistent with a possible increase but is not enough
to establish one; the earlier six-point run was non-monotonic through 69,924
rendered characters. The tab was visible for both sends, and payload capture
was disarmed afterward. The context measure remains rendered transcript text,
not model-token count.

## Continuation 2026-10-03 — fixed-output attempt (inconclusive)

I measured ten turns in one `/app` conversation through the authenticated Gemini
UI. Each turn used the same 58-character prompt, `Output exactly 7. No
punctuation, citation, or other text.` The rendered answer was the same 16
JavaScript characters each time, so answer length was held constant. Model:
`gemini-3.8-flash-lite`; self-reported build:
`boq_gemini-web-uiserver_20261002.02_p0`.

The relay was armed for each turn and disarmed immediately afterward. Completion
was read from the new `model-response` after `aria-busy` cleared. For turns 6–10,
I recorded the first 250 ms poll that saw a settled response, then confirmed the
text stayed unchanged for one second. The table’s latency is completion
observation minus `captures[].at`, so it is interval-censored by at most one poll
interval. Turns 1–5 used an additional two-second stability wait and are shown
separately because that wait adds a fixed delay.

| turn | `f.req` field `[3]` length | answer chars | observed latency (ms) |
|---:|---:|---:|---:|
| 1 | 2672 | 16 | 5427* |
| 2 | 2672 | 16 | 5449* |
| 3 | 2680 | 16 | 6080* |
| 4 | 2680 | 16 | 5446* |
| 5 | 2680 | 16 | 4945* |
| 6 | 2681 | 16 | 29753 |
| 7 | 2681 | 16 | 24695 |
| 8 | 2681 | 16 | 28723 |
| 9 | 2681 | 16 | 26804 |
| 10 | 2681 | 16 | 28845 |

\* Turns 1–5 include the two-second stability wait and are upper estimates.

The result is **inconclusive**. The captured context field changed by only nine
characters across ten turns, while the measured latency shifted from roughly
5–6 seconds in turns 1–5 to 25–30 seconds in turns 6–10. The browser tab was
later brought to the foreground and verified visible/focused, but visibility was
not recorded separately for each request. These captures do not establish that
context length caused the latency change: the measured field did not vary enough,
and service, model-side, or background-throttling conditions could explain the
shift. The original question—whether latency scales with conversation context
while answer length is held fixed—still needs a way to produce substantially
different measured context sizes in the same controlled setup.

No raw request body was written to the report; only sanitized structure lengths,
timestamps, model/build, answer lengths, and grounding metadata were retained.
The relay is disarmed.

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
