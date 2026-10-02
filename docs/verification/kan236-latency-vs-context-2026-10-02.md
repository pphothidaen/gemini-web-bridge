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
