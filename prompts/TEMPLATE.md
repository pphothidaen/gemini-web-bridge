# TEMPLATE — the full document

## Read this before using it as one request

**As a single request, this template was measured to fail.** 2026-10-01, same
notebook and same `birth_context`, only the query differing:

| query | citations | outcome |
| :--- | --- | :--- |
| `01-birth-chart.md` | **5** | grounded |
| this whole template | **0** | refused, `no_citations_in_response` |

It is kept here for two reasons: it is the shape of the final document, and it
is the thing the atomic files were derived from. **Run the sections
separately** — see *Assembly* below.

## The template

> Act as a panel of expert astrologers specializing in Thai, Korean, Chinese,
> and broader Eastern astrology. `{{NAME}}` was born on `{{BIRTH_DATE}}` at
> `{{BIRTH_TIME}}` in `{{BIRTH_PLACE}}`. Please provide a comprehensive
> fortune-telling analysis covering Birth Chart, Destiny, Fate, and current
> stage of life.
>
> Summarize your findings and compile them into a complete document titled
> `{{TITLE}}`, formatted in Thai, including:
>
> **Birth Chart** — a detailed breakdown across the different astrological
> systems.
> **Base Fortune** — luck, life trajectory, love, career, skills, wealth.
> **Turning Points** — the exact ages at which major turning points occur,
> how, and why.
> **Future Forecast (`{{FROM_YEAR}}`–`{{TO_YEAR}}`)** — `{{GRANULARITY}}` detail.
> **Additional Insights** — anything else the experts would flag.
>
> Please output the entire response in Thai so I can export it as a PDF.

`{{TITLE}}` is the caller's document title. The worked example in circulation
is `'Sittiphol's Fate Book'` while the subject is "คุณพรรษกร" (Pansakorn) —
a mismatch that would silently mislabel the exported file. Pick one and use it
consistently; do not copy the example title.

## Assembly

Five conversations, one section each. The notebook is consumed per message, so
each needs a fresh conversation — new tab, or `/app` once the previous
settles.

| step | file | section produced | fixed heading |
| :--- | :--- | :--- | :--- |
| 1 | `01-birth-chart.md` | Birth Chart | `## แผนภูมิกำเนิด (Birth Chart)` |
| 2 | `02-base-fortune.md` | Base Fortune | `## ดวงพื้นฐาน (Base Fortune)` |
| 3 | `03-turning-points.md` | Turning Points | `## จุดเปลี่ยน (Turning Points)` |
| 4 | `04-forecast.md` | Future Forecast | `## พยากรณ์อนาคต (Future Forecast)` |
| 5 | `05-additional-insights.md` | Additional Insights | `## ข้อควรระวัง (Additional Insights)` |

Each stage prompt asks for its fixed heading as the first line of its answer,
so concatenation is literal: title line, then the five answers in step order.
If stage 4 had to be split by year, reassemble its answers under its one
heading first — see the *Reassembling a split span* note in `04-forecast.md`.

Each step either grounds or fails on its own. A refusal at step 4 costs the
forecast, not the other four sections — which is the whole reason for the
split.

## Verifying each step

Every request must return with `notebookGrounding.verified === true`. Check it
per conversation; do not assume that one success implies the next.

```
notebookGrounding.verified   true
notebookGrounding.citationCount   > 0
bridgeScope.attachedInPlace  true
```

`verified: false` or `citationCount: 0` means the answer came from general
knowledge. Discard it and narrow the request — see `04-forecast.md` for the
granularity ladder.

## birth_context

Never written by hand. Per api-spec G-4 the deterministic engine computes the
chart and it is passed in as `birth_context`; `horo_consult` receives
interpretation only.

The engine applies true solar time, which can move the hour pillar across a
boundary civil time does not — see the worked case in `01-birth-chart.md`.
Asserting a pillar in the query instead of supplying it produced a confident
wrong chart in testing, which is the failure this rule exists to prevent.