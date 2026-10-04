# horo_consult prompt library

Each file here is one **atomic** request — deliberately separate rather than one
long template, and that is an evidence-driven decision, not a style
preference.

## Why they are split

Measured 2026-10-01 against the live Horo notebook — same conversation shape,
same `birth_context`, only the query differing:

| query | citations | outcome |
| :--- | :--- | :--- |
| one narrow question (hour pillar, 3 sub-parts) | **5** | grounded |
| the full "fate book" in one request | **0** | refused, `no_citations_in_response` |

The broad request asks for five sections across five years, monthly, from a
panel covering Thai, Korean, Chinese and broader Eastern astrology. The
notebook holds BaZi / numerology / Thai astrology. Gemini answered the broad
one from general knowledge and `horo_consult` refused it — the KAN-204
fail-closed path doing its job.

Splitting does not weaken the analysis. It makes each part answerable from
material that actually exists in the notebook, and it makes a partial failure
cost one section instead of the whole document.

## The rule that governs all of them

**The notebook is consumed per message.** `horo_consult` attaches it in place
for a single turn; the next question needs a fresh conversation — a new tab, or
`/app` once the previous one settles.

## Files

| file | one atomic request |
| :--- | :--- |
| `01-birth-chart.md` | the four pillars and what they mean |
| `02-base-fortune.md` | trajectory, love, career, skills, wealth |
| `03-turning-points.md` | ages at which life turns, and why |
| `04-forecast.md` | future forecast — **granularity is a parameter** |
| `05-additional-insights.md` | warnings the experts would flag |
| `TEMPLATE.md` | the whole document, and how to assemble it |

## The shared guardrail block

Every stage prompt carries the same closing block. It is standardized across
all five files so the runtime loader (`horo-prompts.js`) can assert on it:

1. **Method-only opener** — `ตรวจสอบด้วยวิธีการของคุณเท่านั้น ไม่ใช้ความรู้ทั่วไป`
2. **Honesty clause** — `ถ้าข้อมูลใน Notebook ไม่พอ ... ให้บอกตรงๆ ว่าไม่มี อย่าเติมสิ่งที่ไม่มีใน Notebook`
   (present in all five, not just the warnings stage — a fabricated turning
   point is as bad as a fabricated warning)
3. **Fixed assembly heading** — each stage opens its answer with its own `##`
   heading so the five answers concatenate into one document (see *Assembly*
   in `TEMPLATE.md`)
4. **Citation clause** — `อ้างอิงแหล่งที่มาใน Notebook ทุกประเด็น`
5. **Language clause** — `ตอบเป็นภาษาไทย`

`{{LONGITUDE}}` appears in all five. The engine, not the prompt, does the
computation (G-4) — the longitude line is informative framing that keeps the
five prompt blocks structurally identical.

## Placeholders

Filled by the caller (or by `horo-prompts.js` at runtime):

- All stages: `{{NAME}}`, `{{BIRTH_DATE}}`, `{{BIRTH_TIME}}`, `{{BIRTH_PLACE}}`, `{{LONGITUDE}}`, `{{BIRTH_CONTEXT}}`
- `04-forecast.md` only: `{{FROM_YEAR}}`, `{{TO_YEAR}}` (span), `{{TARGET_YEAR}}`, `{{Q}}`, `{{MONTH}}` (fallback variants)

`{{TITLE}}` exists only in `TEMPLATE.md` — it labels the assembled document,
not any single request. `'Sittiphol's Fate Book'` in `TEMPLATE.md` is a
**worked example** of a title, not part of the request — the title belongs to
the caller and must match their subject. A mismatch here silently mislabels the
document.

## birth_context is never written by hand

Per api-spec G-4 the chart is computed by the deterministic engine and passed
in; `horo_consult` receives interpretation only.

This matters more than it sounds. The engine applies **true solar time**, which
can move the hour pillar across a boundary that civil time does not. A worked
case is in `01-birth-chart.md`: a birth at 23:03 GMT+7 in Ratchaburi becomes
22:39 true solar time, which changes the hour pillar from 壬子 to 辛亥 and
removes the 夜子時 question entirely. Asserting a pillar in the prompt —
rather than supplying it — would have produced a confident wrong chart.

## Disciplines

The panel framing is kept in the template because it shapes the answer's
register. But note G-9: the notebook covers **BaZi / numerology / Thai
astrology**. A panel "specializing in Thai, Korean, Chinese and broader Eastern
astrology" asks for material that may not be there — which is a legitimate
question to ask, not a reason to assume an answer, and `horo_consult` will
refuse rather than fill the gap from general knowledge.

Ask each system as its own atomic question when a specific system is what you
need.