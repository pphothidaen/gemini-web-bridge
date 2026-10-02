# Implementation Plan

**Goal:** Diagnose and fix KAN-242 — the typed path failing on any conversation
that has accumulated turns — then finish the KAN-236 payload measurement and
close out, committing, pushing and deploying each phase separately so every
change to production is individually verified and revertable.

## Overview

### What this run inherits

Phase A is complete and verified. At `c040a65`, pushed and deployed:

```
npm test          622 tests / 617 pass / 0 fail / 5 skipped
production        4.7.24, extension CONNECTED_AND_READY, consecutive_errors 0
deploy            run 36905329401, version id 8874ac55-0795-43cd-a222-d8702b6b1e3a
KAN-242           confirmed real via twg — Bug, Backlog, Medium, opened 2026-10-02
repo              clean and synced with origin/main; only prompts/ untracked
```

Phases B through F remain. Phase A step 1 — rotating the leaked GitHub PAT — is
the operator's and is still outstanding.

### What the pre-flight investigation established

Before planning I checked the live browser and the repo. Five findings, three of
which change how the remaining work must be done.

**The Gemini tab is drivable and ready.** Kapture reports tab `133992564` on
`https://gemini.google.com/app`, `visibilityState: visible`, 3 models verified,
extension `CONNECTED_AND_READY`. `ping` answers `Cloud Hub v4.7.24`. The network
monitor enabled cleanly and had already buffered 391 requests. Phases B and D
are therefore executable without further setup.

**`kapture__evaluate` is genuinely broken on this tab — the handoff was right.**
It returns `{"value": {}}` for every script, including the literal `() => 1+1`.
`evalAllowed` reads `true` in the tab metadata, so that flag is misleading; the
return path is what is broken. Every DOM fact must therefore come from
`kapture__elements`, `kapture__dom`, `kapture__screenshot` and
`kapture__console_logs`, which all work correctly.

**The input area has been visually rebuilt, and the selectors still hold.** The
live DOM carries classes the KAN-231 capture never saw: `ui-improvements-phase-1`,
`discovery-feed-theme`, `gem-icon-button` in place of `mdc-icon-button`, and a
`leading-actions-wrapper` where the capture recorded `trailing-actions-wrapper`.

This is worth stating precisely, because it is the most plausible KAN-242
hypothesis and it does **not** survive contact:

1. With the editor empty, `input-area-v2 button:has(mat-icon[data-mat-icon-name="arrow_upward"])`
   matches **nothing** — the send control is not rendered at all.
2. After typing 5 characters into the live editor, the same selector matches a
   button whose `aria-label` is `ส่งข้อความ`, carrying
   `data-mat-icon-name="arrow_upward"`, with no `disabled` and no
   `aria-disabled="true"`.
3. Clearing the editor restored `ql-blank` and the send control disappeared again.

So `SEND_BUTTON` behaves exactly as `prompt-typing.js` and the KAN-231 contract
say it should: absent while empty, present and enabled once text has landed. The
reskin is cosmetic. **The DOM redesign is not the KAN-242 cause**, and the
2026-10-01 capture remains accurate. I typed into the editor during this check
and cleared it afterwards; the editor is verified back at `ql-blank` and no
message was sent.

**The extension build is current, and the verify tool is right to say so.**
`BUILD.json` records `commit: 99c94fa` while HEAD is `c040a65`, which looks stale
at a glance. It is not: `verify_build()` compares a SHA-256 digest of the source
tree (`_source_digest`), not the commit, precisely because the working tree is
usually dirty. Current digest `8a38ec927bc9` matches the stamp exactly, and
`dist/extension/native-recovery.js` contains the KAN-236 idle-deadline fix
(`hardCap` at line 167). `920da49` changed `native-recovery.js` but the build
already included it, because it was made from a dirty tree. No rebuild is needed
before Phase B.

**Phase D's second capture is reachable in a way the handoff thought it was
not.** The handoff recorded `ungrounded-notebook` as impossible because
`horo_consult` always attaches the chip. It also recorded the deeper finding
that the notebook page hosts no conversation at all, which collapses the case
set to three. Both still hold — but the *chip-absent* case is reachable from

### What this plan does and does not do

It diagnoses before it fixes. Phase B produces a record and a one-sentence root
cause; Phase C is written against whatever that says. Two of the four possible
states are one-line changes, one is a larger change, and one — the request going
out and Gemini declining — is not a bridge defect at all.

It does not attempt a direct `StreamGenerate` call. The measurement from
`1a872d6` shows that is not a matter of filling in missing fields: index 2 is a
type contradiction, and index 3 is a 2,187-byte opaque string never shown to be
reconstructible. Phase D may well conclude the direct path is closed, and that
would be a successful outcome rather than a failure.

It does not fabricate a fixture to keep a phase moving. If Phase B cannot produce
the three conversations, or Phase D cannot produce the captures, that is the
finding, and it gets recorded rather than filled in.

### The KAN-242 finding, and why it is diagnosable rather than mysterious

The measured symptom: on a conversation with 2+ accumulated turns, `horo_consult`
fails with `collect_answer_timeout` while `responses on screen=2`, and **no
`StreamGenerate` request was emitted at all**. On a fresh conversation the same
call completes in 12 seconds; on a one-turn conversation it returns 14 citations.

The discriminator already established is the important part: *if `StreamGenerate`
fires, the prompt left; if it does not, the prompt never left.* That splits the
fault cleanly and places it **upstream of collection** — which means the 120 s
timer and the always-zero response count that `[4.7.24]` records as
"known incomplete" are not this failure's cause. Both are fixed in Phase C
anyway, but neither would have prevented this.

That leaves the submit step, and it has a specific weakness. `typeAndSend` in
`extension-cloudflare/prompt-typing.js` confirms submission like this:

```js
const before = countUserQueries(doc);
send.click();
const accepted = await waitFor((d) => countUserQueries(d) > before ? true : null, …);
…
return { ok: true, submitted: true, responsesBefore };
```

A `user-query` node appearing is treated as proof the request was issued. If the
query bubble renders optimistically — the page committing the user's own turn
before the network call — then `submitted: true` means "the transcript grew",
not "Gemini was asked". Nothing in the current chain distinguishes those two,
which is why this surfaces as a 120-second collection timeout rather than a
submit failure.

So the diagnosis is not a hunt. It is: determine which of four states the submit
lands in on a 2+ turn conversation —

1. the text never reached the editor (`fill` failed, or Angular reconciled it away)
2. the send button was absent or disabled (step 2 never resolved)
3. the click did nothing: `user-query` rose but no request went out
4. the request went out and Gemini declined to answer it

States 1 and 2 are already distinct failures with distinct reasons. State 3 is
invisible today and is the prime suspect. State 4 is not a bridge defect.

### The safety argument that constrains every capture here

`classifyString` in `extension-cloudflare/injected.js` consults a fixed prefix
allowlist — `notebook://`, `http(s)://`, a bare UUID, `boq_`, or a string that
parses as JSON — and returns `OPAQUE` with nothing retained for everything else,
prompts included. The canary in `payload-classifier.test.mjs` fails the moment
anyone adds a prefix, substring, hash or first-N to the output, which is the only
route by which this could begin leaking.

Every fixture and diagnostic record written under this plan inherits that
guarantee **only if it goes through that function**. A record transcribed by hand
from a Kapture network body is not covered by it — the raw body contains the
prompt, the `at` CSRF token, and the session id. The rule for Phases B and D
alike: sanitized structures come from `PAYLOAD_PROBE` records read out of the
console; raw network bodies are read, compared against the probe record, and
**never written down**. `f.sid`, `_reqid`, `at` and cookies are session-derived
and change per page load, so recording them would record expired noise.

### Baseline, measured on this machine at `c040a65` on 2026-10-02

| | |
| :--- | :--- |
| HEAD | `c040a65`, synced with `origin/main` |
| versions | worker `4.7.24` across package.json, lockfile, `WORKER_VERSION`, manifest |
| `npm test` | 622 / 617 pass / 0 fail / 5 skipped |
| extension build | current — digest `8a38ec927bc9`, built from `99c94fa` |
| browser | tab `133992564`, `/app`, visible, extension ONLINE |
| payload captures | **1** (`app-ungrounded-01`, 20 structure entries) |
| recorded divergences | indices 2, 3, 4, 19 — 2 and 4 load_bearing, 3 and 19 unknown |
| analysis artefacts | `analyze-payload-shape.mjs`, `payload-shape-contract.test.mjs`, `submit-diagnostic.test.mjs`, `NOTEBOOK-API-FEASIBILITY.md` — none exist yet |

## Types

No type declarations exist in this codebase: plain JavaScript (ESM in the
worker, IIFE with `module.exports` in the extension) plus Python 3 for the build
script. The shapes below are the data contracts this plan adds. All are plain
JSON-serialisable objects carried in fixtures or message fields — no new runtime
type machinery.

### `SubmitDiagnostic` — new, one observation from a failed submit

The record that makes KAN-242 diagnosable. Structural only, never prompt text.

```js
{
  requestId: "req_<uuid>",
  capturedAt: "2026-10-02T…Z",
  case: "fresh-0-turn" | "short-1-turn" | "long-2plus-turn",
  step: {
    fill:       { landed: true, attempts: 2, editorLength: 749, qlBlank: false },
    sendButton: { found: true, disabled: false, matches: 1 },
    confirm:    { userQueriesBefore: 3, userQueriesAfter: 4, rose: true }
  },
  // The discriminator. `rose: true, streamGenerateSeen: false` is the state
  // that is currently invisible to the bridge and is the prime suspect.
  streamGenerateSeen: false,
  // Proportional counts only — never text, never tokens (GUARDRAILS G1.2.1).
  dom: { modelResponses: 2, sourceChips: 0, pendingRequest: 1, thinkingDots: 1 },
  attach: { attempted: true, ok: true, step: "select", attachedCount: 14 },
  chipPresentBeforeSend: true
}
```

`case` is a closed set because the comparison is the entire point: a free string
could be filed as "long" without saying how long, and the correlation with turn
count is exactly what needs establishing.

The two fields that carry the diagnosis are `step.confirm.rose` and
`streamGenerateSeen`. Together they separate state 3 from states 1, 2 and 4
without needing any further capture.

### `SubmitProbeRecord` — new, the in-page observation

```js
{
  requestId: "req_<uuid>",
  endpoint: "StreamGenerate" | "BatchExecute",
  transport: "fetch" | "xhr",
  buildLabel: "boq_assistant-bard-web-server_20260929.03_p0",
  // Timestamps only. Never the URL query — it carries `at`, `f.sid` and
  // `_reqid`, all session-derived (G1.1.2: first-party tokens must not leave
  // the browser).
  observedAt: 1758000000000,
  // The existing sanitized fingerprint, reused verbatim from
  // decodeAndSanitizePayload → extractBoundedStructure. Not re-derived.
  structure: [ /* extractBoundedStructure output */ ]
}
```

This reuses `decodeAndSanitizePayload` rather than adding a second decoder. The
project's own history is that a second source of truth about a payload is the
defect class that keeps recurring — the DOM contract, the `/v1`–`/v2` handler,
and the `f.req` builder itself are all instances.

### `PayloadCapture` — the case set is three, not four

The superseded plan listed `ungrounded-notebook` as a fourth case. `1a872d6`
measured that the notebook page does not host a conversation at all — asking
there issues `GET /notebook/…` then `GET /app`, spawning a new conversation under
`/app/<new-id>`. Every conversation that has ever carried a notebook reference
therefore lives under `/app`, and the reference is a property of the **chip**,
not of the page. So the comparison is chip-present versus chip-absent *within*
`/app`.

```json
{
  "captureId": "app-chip-present-01",
  "capturedAt": "2026-10-02T09:00:20Z",
  "case": "app-chip-present" | "app-chip-absent" | "app-chip-repeat",
  "endpoint": "StreamGenerate",
  "transport": "fetch",
  "buildLabel": "boq_assistant-bard-web-server_20260929.03_p0",
  "outerLength": 2,
  "hasEnvelope": true,
  "structure": [ /* extractBoundedStructure output, verbatim */ ]
}
```

The existing fixture's `case` value `ungrounded-app` is renamed to
`app-chip-absent` when the chip-present capture is added, and the rename is noted
in the fixture's own `_note`. Keeping the obsolete fourth case would be the same
defect as planning a capture of a surface that cannot exist: it would let a
fixture appear under a name that means nothing.

### `StructureField` and `FieldDelta` — carried over, unchanged

```js
{ index: 3, kind: "string"|"number"|"null"|"array"|"object",
  length: 2187, cls: "opaque", nested: StructureField[] }

{ index: 2,
  workerValue: "[conversationId, responseId, choiceId, null, null, []]",
  observedValue: { kind: "null" },
  significance: "load_bearing" | "incidental" | "unknown",
  note: "type contradiction, not a length difference" }
```

`significance` is deliberately not derived from the delta. A field that differs
between chip-present and chip-absent is *interesting*, not *required*; only the
capture can say which.

## Files

### New

**`cloudflare-worker/tests/fixtures/submit-diagnostics.json` — created, Phase B**

The three measured records. Committed as `9f7405c`. Verdict `NOT_REPRODUCED`.

**`cloudflare-worker/tests/submit-diagnostic.test.mjs`** — **not created.**
Planned against a state Phase B did not observe; see the Functions section for
why it was abandoned rather than written.

**`cloudflare-worker/tests/payload-shape-contract.test.mjs`**

Pins the payload fixtures and asserts the worker builder still produces what the
captures say the endpoint expects. Deliberately written so its divergence
assertion **fails today** — the whole finding is that they differ — with the
divergence enumerated in the message rather than merely flagged. A test that
passes while documenting a known divergence teaches the next reader to skip it.

**`scripts/analyze-payload-shape.mjs`**

The diff. Reads the captures, reduces each to a flat `StructureField` list, and
prints where the worker's builder and the observed payload disagree — by index,
kind and class. Exits non-zero when they describe incompatible shapes.

It reads `cloudflare-worker/src/index.js` for the builder rather than duplicating
it. A script carrying its own copy of the layout it is checking is a second source
of truth, which is the defect class this project keeps rediscovering.

**`docs/NOTEBOOK-API-FEASIBILITY.md`**

The assessment. Five sections: what was measured with capture ids; the
field-by-field divergence; the context block (what is known, how its size moves,
whether any structure was recoverable); session requirements and what they rule
out; a verdict on reachability with the evidence for it.

The verdict is allowed to be "not reachable", and on current evidence likely is.
A document concluding the direct path is closed is a **successful** outcome; one
concluding it is open on the strength of an unexamined 2 KB string is not.

### Modified

**`extension-cloudflare/prompt-typing.js`, `extension-cloudflare/injected.js`,
`extension-cloudflare/content.js`** — **unchanged.** All three were specified for
the submit-window probe and its classifier. Phase B found no failing state, so
there is nothing for them to do. Recording them as untouched is the honest
outcome, not an omission.

**`cloudflare-worker/src/index.js`** — `collectTypedAnswer` only: the idle-aware
timer and the live response count. **Not** the `f.req` builder, and **not**
`recordSubmitDiagnostic`.

**`cloudflare-worker/package.json`, `cloudflare-worker/package-lock.json`,
`const WORKER_VERSION`** — bumped together in Phase C.
`version-consistency.test.mjs` makes the unified release line a hard failure, so
they must move as one. The extension manifest moves only if the extension source
changes, which Phase C no longer does.

**`CHANGELOG.md`** — one `[Unreleased]` → `### Fixed` entry for the two timer
defects; the Phase D artefacts go under `### Added`.

**`PLANNING-HANDOFF.md`** — whatever remains open, in the form GUARDRAILS G4.1.1
requires. No `TODO`/`FIXME` markers in `cloudflare-worker/src/` or
`extension-cloudflare/`; unfinished work goes here.

### Not touched

**The `f.req` builder at `cloudflare-worker/src/index.js:150-159`** — the
*subject* of the Phase D measurement, not its object. Changing it blind is what
produced KAN-182's workaround.

**`extension-cloudflare/manifest.json`'s DOM selectors and the KAN-231 contract** —
the pre-flight check confirmed the send button still appears only once text has
landed, so the reskin did not invalidate the capture.

**The payload probe's console-only sink** — correct under G1.2.1 and
load-bearing: the console is the only sink that cannot persist anything.

**`prompts/`** — seven untracked files whose README claim is contradicted by the
measurements above it. It stays untracked. Deciding its fate needs its own
evidence.

**`classifyString`'s `notebook://` prefix** — unchanged until Phase D step 27
provides the evidence. Widening an allowlist that is the last thing standing
between a prompt and a persisted fixture is not a change to make on a hunch.

## Functions

### Dropped after Phase B — never implemented, deliberately

`describeSubmitState`, `waitForSubmitSignal`, `handleSubmitProbe`,
`probeRecordForSubmit`, `recordSubmitDiagnostic`, and the `submit-diagnostic`
test file were all specified against a state 3 that Phase B did not observe.
Writing a five-way classifier to distinguish a failure that did not occur would
be inventing a defect and then shipping a fix for it. They are recorded here as
abandoned rather than deleted silently, so a future session does not re-derive
the same plan from the symptom alone.

If KAN-242 is ever reproduced, `SubmitDiagnostic` in
`cloudflare-worker/tests/fixtures/submit-diagnostics.json` is the shape these
would return, and the three cases already recorded there are the baseline a new
run would be compared against.

### New: `flattenStructure`, `describeWorkerBuilder`, `diffShapes`, `assessReachability`

All four in `scripts/analyze-payload-shape.mjs`. One refinement:
`describeWorkerBuilder` matches on the `// โครงสร้าง f.req array ของ Google Web
RPC` comment plus the enclosing `return JSON.stringify([null, …])`, and **fails
loudly** when it cannot find them rather than returning an empty list — because
"found nothing" and "found nothing to compare" would otherwise look identical,
which is the exact failure mode of a measurement tool reporting no differences.

### Not modified: `typeAndSend(opts)` — Phase B found nothing to fix

Recorded because the analysis was done and the answer was negative.
`extension-cloudflare/prompt-typing.js` is **unchanged**, and the KAN-231
capture that describes its selectors still holds. The original plan read:

- **State 3** (transcript grew, no request): replace the `countUserQueries` check
  with `describeSubmitState(...)` and fail fast with
  `prompt_not_submitted_reason=transcript_grew_without_request` instead of
  reporting `ok: true` and waiting 120 s for an answer to a request never made.
  This alone turns a 120-second timeout into an immediate, accurate error,
  whatever the underlying cause turns out to be.
- **States 1 and 2**: already fail with `prompt_text_not_applied` /
  `send_button_not_found`; the fix is upstream and the diagnostic identifies which.
- **State 4**: nothing changes here; recorded as Gemini-side behaviour.

In every case `responsesBefore` continues to be sampled **before** the click. It
is the attribution baseline and KAN-182 depends on it.

### Modified: `collectTypedAnswer({ requestId, timeoutMs, responsesBefore })`

`cloudflare-worker/src/index.js:2152`. Two known-incomplete items from `[4.7.24]`,
both fixed in the same commit as the KAN-242 change so the changelog describes one
failure rather than two:

1. The flat 120 s timer becomes idle-aware, mirroring the split
   `waitForResponseChange` already uses extension-side. The hard cap stays, so a
   page stuck showing a spinner forever still fails rather than hangs.
2. `lastCollectedResponseCount` is read on the timeout path although it is only
   written when a `COLLECT_ANSWER_RESULT` arrives — so it is always `0` there,
   and the message reports `responses on screen=0` when the page held 5. The fix
   is a periodic count message from the extension while collection is in flight.

Neither fixes KAN-242. They are here because they are already diagnosed, already
documented as incomplete, and in the same code path a reader will be looking at.

### Modified: `classifyString(str)` — gated, not yet

`STRING_CLASS.NOTEBOOK_REF` matches `"notebook://"`, with a scheme separator. The
payload carries `"notebooks/"`, without one, so a notebook reference classifies
as `OPAQUE`. That is why KAN-195 could see only a *length* difference between
grounded and ungrounded captures — the one bit that would have settled it was
being thrown away by the classifier.

The fix is to match the prefix actually on the wire, and it happens only if Phase
D step 25 shows the context block is reconstructible. The canary in
`payload-classifier.test.mjs` is re-run and must still fail on any attempt to
retain content.

### Removed

None. `sendButtonFallback` is the one candidate — see Phase E — and even there the
plan records the evidence and decides, rather than deleting on a hunch.

## Classes

None added. None removed.

The worker exposes one Durable Object class (`GeminiBridgeDO`,
`cloudflare-worker/src/index.js`) and the extension uses IIFEs with a registry
`Map` (`extension-cloudflare/model-adapter.js:17`). Everything this plan adds is
procedural: four functions in `scripts/analyze-payload-shape.mjs`, five across the
extension files, one bounded ring buffer on the DO instance.

`GeminiBridgeDO` gains **data**, not behaviour: `this.submitDiagnostics`, a
5-entry ring of sanitized `SubmitDiagnostic` records, and one line in the health
payload exposing it.

## Dependencies

**None added.** No package changes, no version bumps. This plan adds a JSON
fixture, one analysis script, and functions to files that already exist.

The script uses `node:fs`, `node:path` and `node:url` — the same three
`build-stamp.test.mjs` already uses, and the direct precedent for a script in this
repo that reads source rather than importing it. The tests use `node:test`,
`node:assert/strict` and `node:module`, matching every other file in
`cloudflare-worker/tests/`.

**Capture needs Kapture**, already installed, with `network_monitor`,
`network_requests`, `network_body`, `console_logs`, `elements`, `dom` and
`type`/`focus`/`click`. No new integration is introduced — and that matters,
because the capture is a browser-side act no test can perform.

**`kapture__evaluate` must not be relied on.** It returns `{}` for every script
on this tab, verified with `() => 1+1`. Every DOM read in Phase B goes through
`elements`, `dom`, `screenshot` or `console_logs`.

**Two operational dependencies, not code ones:**

- `twg` must be authenticated for any Jira call. Auth comes from
  `~/.config/twg/auth.conf`; do **not** `source ~/.zshrc` to get it.
- The extension build must be current before a live run means anything. Verified
  current at digest `8a38ec927bc9`; re-check with
  `python3 scripts/build-extension.py --verify` after Phase C's extension edits,
  and reload at `chrome://extensions`. A worker deploy does not touch the
  extension — they are two separate deliveries.

## Testing

**`submit-diagnostic.test.mjs`** — the state matrix, all five branches, against
stub documents:

1. probe record present + `user-query` rose → `request_issued`
2. `user-query` rose, no probe record → `transcript_grew_without_request`
3. editor `ql-blank` after fill → `editor_did_not_hold`
4. no enabled send button → `no_send_button`
5. probe window not yet elapsed → `no_record_yet`

Case 2 is the one that matters and the one with no coverage today. It is pinned
from both directions: with the fix it must be reported as a failure, and a
mutation making it report `ok: true` must be observed to fail the test.

**`collect-typed-answer-deadline.test.mjs`** — extended for the idle-aware worker
timer, in the same style as the existing extension-side tests: it must slide for a
live generation and still stop for a dead one. The count-on-timeout fix gets its
own assertion: a timeout with the extension reporting 5 must render
`responses on screen=5`, not 0.

**`payload-shape-contract.test.mjs`** — four assertions, the third expected to
fail today:

1. every capture parses and names a `case` from the **three**-element closed set
2. `app-chip-present` and `app-chip-repeat` produce the same shape at the indices
   carrying the prompt and the notebook reference — what makes the first capture
   trustworthy rather than a one-off
3. `flattenStructure` of the observed captures and of the worker builder disagree
   at a non-empty set of indices, and the expected set is pinned so the day
   someone fixes the builder, the test says so
4. no string in any capture has a `cls` outside `STRING_CLASS`, and none retains
   its content

Point 4 restates the canary at the fixture level: `payload-classifier.test.mjs`
proves the function is safe; this proves the *output that ships* is safe.

**The analysis script's own tests** — `diffShapes` and `describeWorkerBuilder`
pinned against hand-built shapes, so a bug in the comparison is not mistaken for a
finding about the payload. The analysis tool is the only thing standing between a
capture and a conclusion, and it gets tested like one.

**Mutation checks** — the standing practice, applied for a specific reason: the
failure mode of a measurement plan is a tool that reports no differences.

- make `describeSubmitState` return `request_issued` whenever `user-query` rose
  → the state-2 test must go red
- truncate `diffShapes` to the first five indices → a deliberate out-of-range
  delta must surface
- key `flattenStructure` by bare index instead of path → nested divergence must
  stop being attributed correctly
- delete the notebook-reference field from an `app-chip-present` capture → the
  chip-present/chip-absent comparison must fail, proving the fixtures are what the
  conclusion rests on
- replace the source-extraction failure with an empty shape → the extractor test
  must fail, because "found nothing" and "found nothing to compare" look identical
- add a substring to `classifyString` output → the existing canary must fail

**Stated plainly.** Nothing here verifies that Gemini behaves correctly, and
nothing verifies that a direct call is possible. It verifies that the shape of the
real request is recorded, that the worker's builder does not match it, and that
the analysis tool reporting that is itself correct. The last of those three is the
one a reader is most entitled to distrust, which is why its mutations are listed.

**Regression.** `cd cloudflare-worker && npm test` must stay at 0 fail. Phases C
and D add tests, so the total rises by exactly the number added; no existing test
may change result. Phase E may remove one (`send_button_fallback`) if the evidence
says the selector is dead — a deliberate decrease, recorded in the commit.

## Implementation Order

Each phase ends with its own commit, push and approved deploy, per the decision
to keep every production change individually verifiable and revertable. Every
push cites `KAN-242` or `KAN-236`, both confirmed to exist in Jira.

### Phase B — Diagnose KAN-242 (browser required, no code)

**Measure first. This phase produces a record, not a fix.**

1. Confirm the tab is `visible` and the extension is `CONNECTED_AND_READY`
   before anything else. A run against a backgrounded tab is a silent no-op.
2. Enable the network monitor and clear the buffer (`force: true`) before each
   run — the buffer rotates at 2000 entries, and the previous session's missed
   capture came from reading it once at the end instead of in intervals.
3. Run `horo_consult` against **three** conversations in order: a fresh `/app`, a
   1-turn conversation, and a 2+ turn conversation. Before each, record the DOM
   state via `kapture__elements` — `user-query` and `model-response` counts,
   `thinking-dots-animation`, `pending-request`, `aria-busy`.
4. After each run, read `network_requests` **with `since:` cursors**, not one
   read at the end. Look for `StreamGenerate`. Record whether it fired.
5. Write one `SubmitDiagnostic` per case into `submit-diagnostics.json`.
6. **State the root cause in one sentence, and stop.** Four possibilities, four
   different fixes, and two of them are not fixes at all. If the evidence points
   at state 4 — the request went out and Gemini declined — the typed path is
   behaving correctly and the problem is upstream in Gemini, which is a finding to
   record rather than a defect to patch.

If the three conversations cannot be produced on demand, that is the finding and
the phase stops there. A fabricated `submit-diagnostics.json` is worse than an
absent one.

**Gate:** I report the root cause before writing any fix code.

#### RESULT — Phase B executed 2026-10-02: NOT REPRODUCED

Three consecutive grounded `horo_consult` calls on `/app/101e3a288e0253c3`, at
0, 1 and 2 accumulated turns. All three verified; `/health` ended healthy with
`consecutive_errors: 0` and `attach_failures: 0`.

| turns | citations | StreamGenerate fired | duration |
| :--- | :--- | :--- | :--- |
| 0 | 7 | yes (seq 11) | 38292 ms |
| 1 | 5 | yes (seq 14) | 38353 ms |
| 2 | 3 | yes (seq 10) | 36151 ms |

The plan predicted state 3 — transcript grew, no request issued. That did **not**
happen. StreamGenerate fired on every run. Recorded in
`cloudflare-worker/tests/fixtures/submit-diagnostics.json`, committed as
`9f7405c`.

Three hypotheses were **eliminated with evidence**, not assumed away:

- The Gemini input-area reskin (`ui-improvements-phase-1`, `gem-icon-button`,
  `leading-actions-wrapper`) does **not** break the send selector. Tested
  directly: zero matches while the editor is empty, an enabled
  `ส่งข้อความ` button after typing, zero again after clearing. Exactly what
  KAN-231 records.
- The extension build is **not** stale. `verify_build()` compares a source
  digest rather than a commit; digest `8a38ec927bc9` matches, and the built
  extension already carries the KAN-236 fix.
- `kapture__evaluate` is **not** usable — returns an empty object for
  `() => 1+1` while reporting `evalAllowed: true`.

**A near-miss that is itself a finding.** The first full-buffer read of
`network_requests` appeared to show zero StreamGenerate requests, which would
have read as a clean reproduction. It was wrong: the tool truncates its output
in the middle when the buffer holds long URLs, and the request sat at seq 11 of
65 inside that region. A request's absence may now only be concluded after every
sequence number has been individually observed. This is the same failure the
2026-10-01 handoff recorded, and it nearly produced a fabricated root cause.

**What remains open.** KAN-242 was reproduced on `/app/72d00678d54a08dd`,
recorded as having 2+ accumulated turns. This run reached 2 accumulated turns
and succeeded. Either the failure needs more turns than were reached, or
something about that specific conversation matters rather than turn count.

**Consequence for Phase C.** There is no failing state to fix, so steps 7–13 as
written have no subject. What remains justified is narrower, and it is stated in
the Phase C section below rather than assumed here.

### Phase C — Narrowed after Phase B: the two timers, not the submit path

Phase B found no failure, so steps 7–13 as originally written have no subject.
Writing a `describeSubmitState` classifier to distinguish a state that was never
observed to occur would be inventing a defect, which is the one thing this
phase exists to avoid. They are dropped.

What survives is narrower and independently justified, because both items were
already diagnosed and already recorded as incomplete in `[4.7.24]`:

7. Make `collectTypedAnswer`'s flat 120 s timer idle-aware, retaining the hard
   cap so a dead page still fails rather than hangs. Phase B measured real
   StreamGenerate durations of 36151–38353 ms, so the margin on a flat 120 s is
   about 3.2x rather than comfortable — and a notebook-grounded answer that
   thinks for two minutes was the case that actually timed out.
8. Add a live response count from the extension during collection, so the
   timeout message stops printing `responses on screen=0` when the page held 5.
   `lastCollectedResponseCount` is only written when a `COLLECT_ANSWER_RESULT`
   arrives, which by definition has not happened on the timeout path.
9. Extend `collect-typed-answer-deadline.test.mjs` for both: the idle deadline
   must slide for a live generation and still stop for a dead one, and a
   timeout with the extension reporting 5 must render 5.
10. Run the Phase C mutations. Observed to fail, then reverted.
11. `CHANGELOG.md` under `[Unreleased]` → `### Fixed`, **one entry for the root
    cause** — not two entries describing two symptoms of it.
12. Bump the worker version to 4.7.25 (`package.json`, `package-lock.json`,
    `WORKER_VERSION` — `version-consistency.test.mjs` makes the unified release
    line a hard failure, so they move together). The extension manifest moves
    only if the extension source changes, which Phase C no longer does.
13. `npm test` must be 0 fail.
14. Commit `KAN-236:`, push, approve the `production` environment, wait for the
    run to finish, then confirm live `/health` shows 4.7.25 and
    `consecutive_errors: 0`.

**Gate:** the deployed version reports 4.7.25 and health is clean. There is no
"failing conversation behaves differently" check, because Phase B established
that no failing conversation was reproduced.

#### RESULT — Phase C executed 2026-10-02: SHIPPED as 4.7.25

Both timer defects fixed, both recorded in `[4.7.25]`. Committed `b5828ea`,
tagged `v4.7.25`, deployed via run `36966455556`, confirmed live at 4.7.25 with
`consecutive_errors: 0`.

Two bugs were found **by the tests, not by review**, and both are worth
recording because each reads as correct in a diff:

- The slide was first written as a *duration* — `timeoutMs + elapsed` — and
  re-armed from the current clock. That compounds: every heartbeat pushed the
  next deadline a full `timeoutMs` further out. Measured 204000 ms of wait in
  100 s of virtual time, and the promise never settled.
- `hardCap` was first enforced by *ceasing to slide* past it, which leaves the
  already-armed timer in place. The call reached 117000 ms against a 90000 ms
  cap and still never returned. A hang is worse than the timeout being fixed.

Three mutations, each observed to fail then reverted: removing the cap
enforcement hangs the suite, removing the count write fails two tests, and
arming with an absolute rather than a relative deadline hangs.

**Degradation is safe and was checked.** With no heartbeat arriving — which is
the case until the extension is reloaded — the timer fires at
`startedAt + timeoutMs`, identical to 4.7.24. The new behaviour is additive, not
a replacement.

**Not yet verified end to end:** the extension half. `content.js` now sends
`COLLECT_ANSWER_PROGRESS` every 3 s, but the browser profile available to this
session is not the one running the Gemini tab, so the extension could not be
reloaded at `chrome://extensions`. Until it is reloaded, the deployed worker
runs with no heartbeat and behaves exactly as 4.7.24 did. A live grounded call
on 4.7.25 succeeded (verified, 2 citations, 3 accumulated turns), which
confirms no regression — but the slide itself stays unexercised in production
until that reload happens.

### Phase D — Finish the KAN-236 measurement (browser required)

19. Enable the payload probe through the page (`PAYLOAD_PROBE_SET`).
20. Capture the **chip-present** half: a grounded `horo_consult` turn in `/app`.
    Set `responsesBefore` correctly — the probe flag resets on navigation, so
    re-enable it after any reload.
21. Capture the **chip-absent** half: a manual `/app` ask with **no chip
    attached**. `horo_consult` can never produce this — attaching is its job.
22. Capture the **chip-repeat** half: a second turn in the same conversation, to
    see whether the context block grows *within* one conversation rather than only
    across conversations.
23. Rename the existing fixture's `case` from `ungrounded-app` to
    `app-chip-absent`, and note the rename in the fixture's `_note`.
24. Transcribe all three **verbatim** from `extractBoundedStructure` output.
    Never from a raw network body.
25. Write `payload-shape-contract.test.mjs` assertions 1, 2 and 4. These should
    pass. If they do not, the capture was transcribed wrong and the answer is to
    re-read the console, not to relax the assertion.
26. Build `scripts/analyze-payload-shape.mjs` — `flattenStructure`, then
    `describeWorkerBuilder`, then `diffShapes`. Unit-test the first and third
    before wiring the second to the real source.
27. Run the diff and **write down what it says** before deciding what it means.
28. Characterise the context block: does its length move with turn count, with the
    page, or not at all? A block byte-identical across a one-turn and a six-turn
    conversation is not conversation state.
29. Add assertion 3 and confirm it fails **for the reason stated in the assertion
    message**. A different failure means the tool is wrong and step 26 is not
    finished.
30. Only now: if step 28 shows the context block is reconstructible, change
    `classifyString` to match `"notebooks/"` and re-run the canary. If it does
    not, leave the classifier alone and record why.
31. Write `docs/NOTEBOOK-API-FEASIBILITY.md`. Steps 19–29 are its evidence; the
    verdict comes last and may be negative.
32. `npm test`, commit `KAN-236:`, push, approve, wait, confirm live.

**Gate:** the assessment exists with a verdict, backed by at least three
sanitized captures.

#### RESULT — Phase D BLOCKED 2026-10-02. No capture taken, nothing written.

Enabling `PAYLOAD_PROBE` requires posting a message into the page. There is no
route to the page's JS context from this session: `kapture__evaluate` returned
`{}` for even `() => 1+1` throughout Phase B, and by Phase D it was no longer
present in the toolset at all.

So the chip-present, chip-absent and chip-repeat captures **do not exist**, and
the 2026-10-01 ungrounded capture could not be re-verified. Verdict recorded in
`docs/NOTEBOOK-API-FEASIBILITY.md` as **NOT ESTABLISHED** — a negative result
reached without fabrication, not a negative finding.

Two things were deliberately *not* done, and both would have been faster:

- **No hand-transcription from a network capture.** The raw `StreamGenerate`
  body holds the full prompt and session tokens, which G1.2.1 keeps out of
  written artifacts. A hand-derived structure would pass
  `payload-classifier.test.mjs`'s leak canary while having been produced by
  exactly the means the canary exists to prevent.
- **No `scripts/analyze-payload-shape.mjs`, no `payload-shape-contract.test.mjs`.**
  Both were planned as consumers of captures that do not exist. Writing them
  would pin a payload shape I cannot substantiate, converting an open question
  into false certainty.

The one capture on file also carries an unresolved **classifier gap** — the
notebook reference was searched for under `notebook://` while the live scope
uses `notebooks://` — so it cannot support a claim that the reference is
absent. `streamgenerate-captures.json` now carries a
`_provenance_unverified_2026_10_02` key at the top saying so, rather than
continuing to assert provenance this session did not establish.

### Phase E — KAN-231 fixture gap (≈30 min)

33. **CORRECTED 2026-10-02: `sendButtonFallback` DOES match.** The earlier claim
    that it "matched zero elements in every captured state" was wrong, and the
    reason it looked true is worth recording — the probe was run against an
    *empty* editor, where Gemini renders no send control at all. Both selectors
    return nothing there, so the fallback looked dead for a reason that had
    nothing to do with the fallback.

    Measured on `/app/101e3a288e0253c3` with one character typed, via Kapture
    `elements`, visible and hidden both included:

    | selector | empty editor | with text |
    |---|---|---|
    | `button:has(mat-icon[arrow_upward])` (primary) | 0 | 1 — `button` |
    | `button.send-button, [data-test-id='send-button']` (fallback) | 0 | 1 — `gem-icon-button.send-button` |

    Both resolve the same control at identical bounds (x 919.5, y 594, 32×32).
    The primary returns the inner `button`; the fallback returns the
    `gem-icon-button.send-button` wrapper containing it. The fallback is real
    markup, not decoration.

    **Decision: keep it, and correct the DOM contract.** It is not redundant in
    the sense that mattered — it is an independent hook on a different element
    (the Angular wrapper, class `lm-enabled`) that survives a Material internals
    change, which is exactly the resilience it was added for. The contract's
    `observed: false` is what is wrong, and it stays in the contract only until
    that is fixed.

    **Done:** recorded under `_remeasured_2026_10_02` in
    `cloudflare-worker/tests/fixtures/prompt-typing.json`, with the method and
    the raw element classes. `dom-signal-contract.test.mjs` still passes 14/14.
34. The pre-flight check re-confirms the primary selector works on today's
    reskinned input area, which makes the fallback question sharper: if the
    primary is healthy *and* the fallback matches nothing, the fallback is
    decoration. Re-query it on the live tab before deciding.
35. Decide with evidence and record it either way:
    - it matches on some reachable surface → it stays, now honestly earned; or
    - it matches nowhere reachable → remove it and drop
      `prompt.send_button_fallback` from the contract, so the corpus stops
      carrying a signal that is decoration.

### Phase F — Close out

36. `prompts/` stays untracked. Its README asserts "splitting does not weaken the
    analysis" directly above the measurement that contradicts it. Deciding its
    fate needs its own evidence.
37. `PLANNING-HANDOFF.md` updated with whatever remains open — the KAN-236
    verdict if negative, the KAN-231 decision if unresolved, and anything Phase B
    could not determine.
38. Update `SESSION_HANDOFF_2026-10-01.md` §4.1 to reflect KAN-242's real status,
    or supersede it with a new dated handoff if this run produced enough to
    warrant one.
39. `node --check` on every touched JS file; `python3 scripts/build-extension.py
    --verify` current; `npm test` 0 fail.
40. Final commit if anything is outstanding, push, approve, confirm live `/health`
    reports the expected version with `consecutive_errors: 0`.

### What each phase needs

| phase | browser | code | deploy | gate |
| :--- | :--- | :--- | :--- | :--- |
| B diagnose | **yes** | no | no | root cause stated |
| C fix | **yes** (verify) | yes | **yes** | failing case now behaves differently |
| D measure | **yes** | script + doc | **yes** | verdict exists, 3 captures |
| E fixtures | possibly | selector | no | decision recorded |
| F close | no | docs | maybe | `/health` clean |

### Two things that will stop me, deliberately

**If Phase B contradicts the plan's diagnosis.** The plan predicts state 3 —
transcript grew, no request issued. If the evidence instead shows state 4, or a
state the plan did not anticipate, I stop and report before writing the fix. The
plan explicitly refuses to ship a workaround for a cause it has not established,
because that is the failure mode the previous session recorded twice.

**If Phase B cannot produce the three conversations.** Then the honest output is a
recorded failure to reproduce, not an invented fixture. The whole measurement
programme rests on that discipline, and breaking it once makes every conclusion
downstream unfalsifiable.

### Remaining operational debt, not in any phase

- **Rotate the leaked GitHub PAT.** Still outstanding from Phase A step 1. It is
  the operator's action and no phase depends on it, but it is the only item on
  this list where damage has already occurred.
- **`cd.yml`'s approval API needs a `comment`.** GitHub rejected the first
  approval with HTTP 422 — `"comment" wasn't supplied`. The handoff's approve
  snippet in §8 omits it. Every deploy approval this run includes the field; the
  snippet should be corrected in Phase F.
`/app` directly, because that is where every conversation carrying a chip lives.