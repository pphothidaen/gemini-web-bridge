# Implementation Plan

**Goal:** Determine — by measurement, not by argument — whether the bridge can
stop driving Gemini's DOM and call its notebook API directly, and document
exactly what stands between the current state and that end goal.

## Overview

The 2026-10-01 smoke testing established three facts that make this question
answerable now rather than someday.

First, the typed path works. KAN-235 taught `isGenerating()` to see the
thinking phase, and a grounded `horo_consult` completed end to end with
`notebookGrounding.verified: true` and five citations. The bridge is not
broken.

Second, the DOM path is nevertheless the only path. Every grounded call pays
for it: the tab must be focused or `send_button_not_found` is returned, the
editor must accept the text or the wait times out, and the conversation
accumulates turns until Gemini stops answering — which is exactly what
happened on a conversation that had reached six.

Third, and decisively, the request the browser actually sends was captured.
A notebook question goes out as:

```
POST https://gemini.google.com/_/BardChatUi/data/
      assistant.lamda.BardFrontendService/StreamGenerate
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
X-Same-Domain: 1
```

with a body of the form `f.req=[null,"<inner JSON>"]` and `at=<token>`. The
inner array carries the prompt at index 0, the notebook id
(`notebooks/b55f1ee0-…`) at roughly index 7, and a ~4 KB opaque string at
index 3 that does not parse as JSON and is not a URL, UUID or build label.

That third fact is the reason this plan exists. The worker already builds an
`f.req` envelope — `cloudflare-worker/src/index.js:150-159` — and it is
**structurally different from the one Google accepts**. It emits ten fields
where the browser emits roughly twenty, it puts `[conversationId, responseId,
choiceId, …]` at index 2 where the browser puts `null`, and it has no notebook
field at all. KAN-182 recorded the symptom ("our assembled StreamGenerate
payload is rejected by a schema change on Google's side") and worked around
it by typing into the DOM instead. Nobody has ever compared the two
side by side.

So the gap is narrow and specific: **the real payload has never been written
down**, and the workaround cannot be evaluated until it is.

### What this plan does and does not do

It measures. It captures the sanitized structure of real StreamGenerate
payloads across the cases that matter, pins the worker's current builder
against them, and produces a written assessment of what reaching a direct
call would require — including the parts that may well be unreachable.

It does **not** attempt a direct call, does not touch production behaviour,
and does not claim the end goal is achievable. Two of the blockers identified
below look structural rather than merely unknown, and the assessment says so
rather than engineering around it.

### What already exists and must not be rebuilt

The measurement apparatus is largely in the tree, which is why this is a
measurement plan and not an instrumentation project.

| existing | location | role here |
| :--- | :--- | :--- |
| `RECOGNIZED_PATHS` | `extension-cloudflare/injected.js:386` | StreamGenerate already intercepted |
| `decodeAndSanitizePayload(rawBody)` | `extension-cloudflare/injected.js:413` | parses the `f.req` envelope |
| `extractBoundedStructure(val, depth)` | `extension-cloudflare/injected.js:447` | builds the sanitized fingerprint |
| `classifyString(str)` | `extension-cloudflare/injected.js:68` | 6-class closed set, incl. `notebook_ref` |
| payload probe + `PAYLOAD_PROBE_SET` | `extension-cloudflare/injected.js:497-524` | runtime toggle, console-only sink |
| `payload-classifier.test.mjs` | `cloudflare-worker/tests/` | 9 tests incl. the leak canary |
| `ProtocolDecoder.decodeChunk` | `cloudflare-worker/src/index.js` | decodes the **response** side |

The one thing none of these produce is a **persisted artefact**. The probe
writes to `console.log` and nowhere else — deliberately, per GUARDRAILS
G1.2.1, because the console is the only sink that cannot persist anything.
That was correct when the capture was one-off; it does not survive a session
boundary, and it cannot be diffed. Turning a console line into a fixture is
the entire deliverable.

### The safety argument for sanitized capture

`classifyString` consults a fixed prefix allowlist — `notebook://`, `http(s)
://`, a bare UUID, `boq_`, or a string that parses as JSON — and returns
`OPAQUE` with nothing retained for everything else, prompts included. The
canary test in `payload-classifier.test.mjs` fails the moment anyone adds a
prefix, a substring, a hash or a first-N to the output, which is the only
route by which this could begin leaking. Every fixture written under this plan
goes through that function and inherits that guarantee; none of them may be
transcribed by hand from a network capture, because a hand transcription is
not covered by it.

### The two blockers, stated before the work starts

These shape the assessment and should shape expectations of it.

**Session binding.** The captured request carries `f.sid=-8757537262754561099`,
`bl=boq_assistant-bard-web-server_20260929.03_p0`, `_reqid=…` and
`at=AIaPT3M-wqKY2uBmtmC2h-ZsXNUS:<timestamp>`. All are session-derived and
change per page load. Combined with the `__Secure-*` cookies the browser holds
for `gemini.google.com`, a request cannot be authored off-browser and
replayed — it must be minted by a live session. This is the same class of
constraint as the retired-host problem: a stale credential produces a
plausible-looking failure rather than an error.

**The opaque context block.** Index 3 in the real payload is a ~4 KB string
that `classifyString` classifies `OPAQUE`: not JSON, not a URL, not a UUID,
not a build label. Whether it is conversation state that can be reconstructed
from known inputs, a server-issued nonce, or something bound to in-page
Angular state is **unknown and is the central open question of this plan**.
Until it is characterised, the direct-call path is not scoped, only outlined.

Everything else — field positions, the notebook reference, the response
decoding, the model plumbing — is already understood.

## Types

No type declarations exist in this codebase: plain JavaScript (ESM in the
worker, IIFE with `module.exports` in the extension) and Python 3 for the
build script. The shapes below are the data contracts the measurement adds.

**`PayloadCapture` — new, one sanitized observation**

```json
{
  "captureId": "notebook-grounded-01",
  "capturedAt": "2026-10-01T09:00:20Z",
  "case": "grounded-notebook",
  "endpoint": "StreamGenerate",
  "transport": "fetch",
  "buildLabel": "boq_assistant-bard-web-server_20260929.03_p0",
  "outerLength": 2,
  "hasEnvelope": true,
  "structure": [ /* extractBoundedStructure output, verbatim */ ]
}
```

`case` is a closed set — `grounded-notebook`, `ungrounded-app`,
`ungrounded-notebook`, `grounded-notebook-repeat` — because the whole point is
comparing cases, and an open string would let a fifth shape appear without
anyone noticing it was not one of the four the plan reasons about.

**`StructureField` — the unit of comparison**

```js
{
  index: 3,
  kind: "string" | "number" | "boolean" | "null" | "array" | "object" | "undefined",
  length: 4096,          // strings only
  cls: "opaque",         // strings only, from STRING_CLASS
  nested: StructureField[]  // arrays/objects, bounded by extractBoundedStructure
}
```

`kind` and `cls` are what make a delta attributable. KAN-195 already learned
this the hard way: two grounded/ungrounded captures differed in a single
top-level field, and only in its length — which is equally consistent with a
notebook reference having appeared, having vanished, or never having been
there and something else of similar length taking its place. Adding `cls` is
what turned that ambiguity into one bit per field.

**`FieldDelta` — what the assessment is written from**

```js
{
  index: 7,
  workerValue: "absent",
  observedValue: { kind: "string", length: 45, cls: "opaque" },
  significance: "load_bearing" | "incidental" | "unknown",
  note: "notebook id; StringClass does not classify this prefix today"
}
```

`significance` is deliberately not derived from the delta. A field that differs
between grounded and ungrounded is *interesting*, not *required*; only the
capture can say which, and the plan records the judgement rather than
inferring it mechanically.

## Files

### New

**`cloudflare-worker/tests/fixtures/streamgenerate-captures.json`**

The persisted artefact, and the reason this plan exists. Holds the
`PayloadCapture` records described above, in the sanitized form
`extractBoundedStructure` produces — never a hand transcription, always the
function's own output.

Four captures minimum:

| `case` | why it is needed |
| :--- | :--- |
| `grounded-notebook` | the shape that works |
| `grounded-notebook-repeat` | proves the first was not a fluke |
| `ungrounded-app` | the shape outside the notebook surface |
| `ungrounded-notebook` | notebook page, no chip attached |

The last two are what isolate the notebook's contribution from the page's. A
comparison of only the first two cannot distinguish "the notebook field
matters" from "any difference between those two conversations matters".

**`scripts/analyze-payload-shape.mjs`**

The diff. Reads the captures, reduces each to a flat list of
`StructureField`, and prints where the worker's builder and the observed
payload disagree — by index, by kind, and by class. Exits non-zero when the
builder and the captures describe incompatible shapes, so it can be run in CI
later if the team decides to hold the line.

It reads `cloudflare-worker/src/index.js` for the builder rather than
duplicating it. A script that carries its own copy of the layout it is
checking is a second source of truth, which is the defect class this whole
project keeps rediscovering.

**`cloudflare-worker/tests/payload-shape-contract.test.mjs`**

Pins the fixtures and asserts the worker builder still produces what the
captures say the endpoint expects. Deliberately written so that **it fails
today** — the whole finding is that they differ — with the divergence
enumerated in the assertion message rather than merely flagged. A test that
passes while documenting a known divergence teaches the next reader to skip
it.

Once the team decides whether direct-send is pursued, this test either gains
a fixture for the corrected builder or is deleted. Either is fine; leaving it
green while the shapes differ is not.

**`docs/NOTEBOOK-API-FEASIBILITY.md`**

The assessment. Not a design document — an honest accounting of what was
measured, what it implies, and what remains unknown. Structure:

1. What was measured, with the capture ids.
2. The field-by-field divergence between the worker builder and the observed
   payload.
3. The context block: what is known about it, how its size moves across
   captures, and whether any structure was recoverable from it.
4. Session requirements, and what they rule out.
5. A verdict on reachability, with the evidence for it — not a hedge.

The verdict is allowed to be "not reachable", and is likely to be. A document
that concludes the direct path is closed is a successful outcome of this
plan; one that concludes it is open on the strength of an unexamined
4 KB string is not.

### Modified

**`CHANGELOG.md`** — one `[Unreleased]` entry recording that the measurement
was taken, what the fixtures are, and what the assessment concluded. Under
`### Added`, since no shipped behaviour changes.

**`docs/api-spec.md`** — a short subsection under the grounding section
pointing at the feasibility assessment, so a reader who hits the DOM
requirement learns that the alternative was investigated rather than never
considered.

### Not touched

- **`cloudflare-worker/src/index.js`** — the `f.req` builder at line 150 is
  the subject of the measurement, not its object. Changing it is the
  end-goal work this plan deliberately does not attempt, and changing it
  blind is what produced KAN-182's workaround in the first place.
- **`extension-cloudflare/injected.js`** — `decodeAndSanitizePayload`,
  `extractBoundedStructure` and `classifyString` already do the job. They are
  read, not rewritten.
- **`extension-cloudflare/content.js`** — the typed path works. Nothing here
  justifies touching it.
- **The payload probe's console-only sink** — correct under GUARDRAILS
  G1.2.1 and explicitly load-bearing: the console is the only sink that
  cannot persist anything. Fixtures are produced by the operator reading the
  console and transcribing the sanitized output, not by giving the probe a
  disk sink.

## Functions

### New: `flattenStructure(structure)`

`scripts/analyze-payload-shape.mjs`. Walks `extractBoundedStructure` output
into a flat array of `StructureField` keyed by path, so two captures can be
compared positionally. Returns `Map<string, StructureField>` keyed by
`"[3]"`, `"[3].children[0]"`, and so on.

Paths rather than bare indices, because the divergence that matters is
nested — a top-level index comparison would report "field 7 differs" and
leave the reader unable to tell which of seven things at that index moved.

### New: `describeWorkerBuilder(source)`

Same file. Extracts the array literal that `index.js` passes to
`JSON.stringify` at the `f.req` construction site and returns it in
`StructureField` form, so worker and observed shapes go through one
comparison path.

Parsing by regex is fragile enough to be a smell, and this is where it is
still the right trade: the alternative is evaluating worker source, which is
worse. The extractor matches on the comment that introduces it
(`// โครงสร้าง f.req array ของ Google Web RPC`) plus the enclosing
`return JSON.stringify([null, …])`, and **fails loudly** when it cannot find
it rather than returning an empty list that would compare as "no
differences".

### New: `diffShapes(worker, observed)`

Same file. Returns `FieldDelta[]`, sorted by index. Pure — no I/O — so it can
be unit-tested against hand-built shapes without a capture.

### New: `assessReachability(deltas, contextBlockObservations)`

`scripts/analyze-payload-shape.mjs`, or a companion module if it grows.
Turns the measurement into the verdict section of the assessment. Its input is
explicit so the verdict can be re-derived when new captures land, rather than
being prose that has to be rewritten by hand.

### Modified

None. No function in `cloudflare-worker/src/` or `extension-cloudflare/`
changes under this plan.

### Removed

None.

## Classes

None. The codebase is procedural where this plan touches: the worker exposes
a Durable Object class (`GeminiBridgeDO`) and the extension uses IIFEs with a
registry `Map` (`model-adapter.js:17`). The analysis script is a module with
functions and no state beyond its two inputs.

## Dependencies

None added. No package changes, no version bumps of existing packages.

The script uses `node:fs`, `node:path` and `node:url` — the same three
`build-stamp.test.mjs` already uses, and the direct precedent for a script in
this repo that reads source rather than importing it.

The tests use `node:test`, `node:assert/strict` and `node:module`, matching
every other test file in `cloudflare-worker/tests/`.

The capture itself needs Kapture, which is already installed and already has
`network_monitor` and `console_logs`. **No new integration is introduced** —
and that matters, because the capture is a browser-side act that no test can
perform.

## Testing

**The contract test** — `payload-shape-contract.test.mjs` asserts four
things, and the first is expected to fail today:

1. every capture in the fixture parses and names a `case` from the closed set
2. `grounded-notebook` and `grounded-notebook-repeat` produce the same shape
   at the indices that carry the prompt and the notebook reference — this is
   what makes the first capture trustworthy rather than a one-off
3. `flattenStructure` of the observed captures and of the worker builder
   disagree at a non-empty set of indices, and the expected set is pinned so
   the day someone fixes the builder, the test says so
4. no string in any capture has `cls` other than a value from `STRING_CLASS`,
   and none retains its content

Point 4 restates the canary at the fixture level. `payload-classifier.test.mjs`
proves the function is safe; this proves the *output that ships* is safe, which
is the thing that actually reaches the repo.

**The analysis script's own tests** — `diffShapes` and `describeWorkerBuilder`
pinned against hand-built shapes, so a bug in the comparison is not mistaken
for a finding about the payload. This distinction is the whole point: the
analysis tool is the only thing standing between a capture and a conclusion,
and it gets tested like one.

**Mutation checks.** The project's standing practice, and it applies here for
a specific reason — the failure mode of a measurement plan is a tool that
reports no differences:

- make `diffShapes` compare only the first five indices → must surface a
  deliberate out-of-range delta in the fixture and go red
- make `flattenStructure` key by bare index instead of path → the nested
  divergence must stop being attributed correctly
- delete the notebook-reference field from a `grounded-notebook` capture →
  the grounded/ungrounded comparison test must fail, proving the fixtures are
  what the conclusion rests on
- replace the source-extraction failure with an empty shape → the extractor
  test must fail, because "found nothing" and "found nothing to compare" look
  identical otherwise

**Stated plainly.** Nothing here verifies that Gemini behaves correctly, and
nothing here verifies that a direct call is possible. It verifies that the
shape of the real request is recorded, that the worker's builder does not
match it, and that the analysis tool reporting that is itself correct. The
last of those three is the one a reader is most entitled to distrust, which is
why its mutations are listed explicitly.

**Regression.** `cd cloudflare-worker && npm test` — currently 622 tests /
617 pass / 0 fail / 5 skipped. This plan adds no production behaviour, so
the count must not change; any movement is a mistake, not an improvement.

## Implementation Order

1. **Capture, do not analyse.** Enable the payload probe through the page
   (`PAYLOAD_PROBE_SET`), ask one question per case in the four cases above,
   and read the sanitized records from the browser console. Transcribe the
   `extractBoundedStructure` output **verbatim** into
   `streamgenerate-captures.json`. Nothing is interpreted at this stage —
   interpretation before the raw record exists is how the earlier sessions
   produced three wrong conclusions in a row.

2. **Write the fixture test first.** `payload-shape-contract.test.mjs` with
   points 1, 2 and 4. It should pass; if it does not, the capture was
   transcribed wrong and the answer is to re-read the console, not to relax
   the assertion.

3. **Build the analysis script.** `flattenStructure`, then
   `describeWorkerBuilder`, then `diffShapes`. Unit-test the first and third
   before wiring the second to the real source.

4. **Run the diff and write down what it says** — before deciding what it
   means. The delta table goes into the assessment as a table.

5. **Characterise the context block.** Across the four captures: does its
   length move? Does it move with the number of prior turns, with the page,
   or not at all? A block that is byte-identical across a one-turn and a
   six-turn conversation is not conversation state. This step decides
   whether step 7 has a subject.

6. **Add the contract test's divergence assertion** and confirm it fails for
   the reason stated in the assertion message. If it fails for another
   reason, the tool is wrong and step 3 is not finished.

7. **Run the four mutations.** Each observed to fail, then reverted.

8. **Write `docs/NOTEBOOK-API-FEASIBILITY.md`.** Steps 1–6 are its evidence.
   The verdict comes last and may be negative.

9. **Full suite** with the count unchanged at 617 passing, `node --check` on
   every new file, and the measured numbers stated rather than the expected
   ones.

Step 1 needs the browser and a focused Gemini tab, and step 5's question —
whether the context block tracks conversation length — needs a conversation
that has already accumulated turns. Both need the operator. Everything from
step 2 runs in `npm test` with no browser.

The plan halts at step 8. It does not proceed to attempt a direct call,
because reaching one is a separate decision that needs the verdict from step
8 first, and possibly a different approach entirely — the measured fact that
the request is session-bound points at keeping the browser in the loop and
replacing only the DOM scraping, which is a smaller change than the one this
plan is scoping.
