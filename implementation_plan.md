# Implementation Plan

**Goal:** Close out the 2026-10-01 session in the order that removes risk first
(leaked credential, unpushed work, a red suite), then fix the defect that will
actually bite in daily use — the typed path failing on any conversation that
has accumulated turns — and only then finish the payload measurement that was
left half-done.

## Overview

This plan supersedes the earlier `implementation_plan.md` committed at
`1a872d6`. That document scoped the KAN-236 payload measurement alone, on the
assumption that it was the next thing to do. It is still substantially correct
about that work, and its reasoning about the two structural blockers is worth
keeping. Two things have changed since, and both change the order of work:

**The suite is red at HEAD.** Measured just now on `11524c2`:

```
tests 622 · pass 616 · fail 1 · skipped 5 · duration 46.2s
✖ no committable file outside the allowlist names the retired production host
      actual: [ 'SESSION_HANDOFF_2026-10-01.md' ]
```

`SESSION_HANDOFF_2026-10-01.md` names
The retired production host at what is now line 219, inside the block
explaining the host is retired and must not be used. It is not on
`HISTORICAL_ALLOWLIST` in `cloudflare-worker/tests/production-host.test.mjs`,
so the KAN-223 sweep rejects it. The file was introduced by `11524c2` itself —
the test passed at `1a872d6`. The handoff's own status line says "0 fail", which
was true when written and is false now.

This matters beyond tidiness. `.clinerules/01-governance.md` requires
`npm test` to pass with 0 fail before pushing, and `pre-push` asks Jira about
cited tickets on the way out. Pushing three commits while the suite is red means
the first thing CI says about this branch is a failure, which trains everyone to
ignore red. The suite goes green **before** the push — the opposite of the
order the handoff gives.

**KAN-242 is not a ticket yet.** It appears in exactly one place in the repo:
`SESSION_HANDOFF_2026-10-01.md` §4.1. It is not in `PLANNING-HANDOFF.md`, not in
`docs/COMMIT_TICKET_MAPPING.md`, and governance forbids citing a ticket number
not confirmed to exist. The number may well be right — presumably taken from
Jira at the time — but it must be verified with
`twg jira workitem get KAN-242` before any commit cites it. If it does not
exist, a real ticket is created and the work is committed under that key.

### What is actually broken, as distinct from what is unwritten

The handoff groups several open items together, and they are not the same kind
of thing. Separating them changes what each step costs:

| item | kind | cost | risk if skipped |
| :--- | :--- | :--- | :--- |
| leaked GitHub PAT | security, already happened | 5 min | credential is live |
| red suite at HEAD | regression, already happened | 10 min | CI fails on push |
| 3 unpushed commits | housekeeping | 2 min | work is one `git gc` from gone |
| **KAN-242 typed path** | **product defect** | **hours + operator** | **every repeat call fails** |
| KAN-236 second capture | measurement, incomplete | operator + ~2h | assessment stays unfounded |
| KAN-231 fallback selector | dead code claim | 30 min | a "safety net" that is not one |

KAN-242 is the only item that changes what users experience. The rest close
bookkeeping or complete a study. That is why it gets the depth here and the
others get a phase each.

### The KAN-242 finding, and why it is diagnosable rather than mysterious

The measured symptom, from the handoff: on a conversation with 2+ accumulated
turns, `horo_consult` fails with `collect_answer_timeout` while
`responses on screen=2`, and **no `StreamGenerate` request was emitted at all**.
On a fresh conversation the same call completes in 12 seconds. On a one-turn
conversation it completes with 14 citations.

The discriminator the previous session already established is the important
part: *if `StreamGenerate` fires, the prompt left; if it does not, the prompt
never left.* That splits the fault cleanly, and it splits it **upstream of
collection** — which means the 120 s timer and the wrong response count that
`[4.7.24]` records as "known incomplete" are, on this evidence, not the cause.
They are real defects and this plan fixes them too, but fixing them would not
have prevented this failure.

That leaves the submit step, and there is a specific weakness in it.
`typeAndSend` in `extension-cloudflare/prompt-typing.js` confirms submission
like this:

```js
const before = countUserQueries(doc);
send.click();
const accepted = await waitFor((d) => countUserQueries(d) > before ? true : null, …);
…
return { ok: true, submitted: true, responsesBefore };
```

A `user-query` node appearing is treated as proof the request was issued. On
this build the query bubble renders optimistically — the page commits the user's
own turn to the transcript before the network call is made. So `submitted: true`
means "the transcript grew", not "Gemini was asked". Nothing in the current
signal chain distinguishes those two, which is exactly why the failure surfaced
as a 120-second collection timeout rather than as a submit failure: the bridge
believed it had submitted, then waited for an answer to a request that was
never sent.

So the diagnosis is not a hunt. It is: determine which of four states the
submit lands in on a 2+ turn conversation —

1. the text never reached the editor (`fill` failed, or Angular reconciled it away)
2. the send button was absent or disabled (step 2 never resolved)
3. the click did nothing: `user-query` rose but no request went out
4. the request went out and Gemini declined to answer it

— using the payload probe and Kapture's network monitor, which between them can
see both the DOM state and whether `StreamGenerate` fired. Each state implies a
different fix, and two of them are one-line changes while one of them is not

### What this plan deliberately does not do

It does not attempt a direct `StreamGenerate` call from the worker. The
measurement from `1a872d6` says that is not a matter of filling in missing
fields: index 2 is a **type contradiction** (worker puts
`[conversationId, responseId, choiceId, null, null, []]`, the browser puts
`null`), and index 3 is a 2,187-byte opaque string never shown to be
reconstructible. That is a separate decision needing the Phase D verdict first.

It does not ship a workaround for KAN-242 before the cause is known. A
"start a fresh conversation every call" guard would make the symptom disappear
and teach nobody anything, which is the specific failure mode the last session
recorded twice.

### Baseline, measured rather than quoted

Everything below was read or run on this machine on 2026-10-02, at `11524c2`:

| | |
| :--- | :--- |
| HEAD | `11524c2` on `main`; unpushed: `20d2e01`, `1a872d6`, `11524c2` |
| working tree | clean except untracked `prompts/` (7 files, deliberately uncommitted) |
| worker version | 4.7.24 — `package.json`, `WORKER_VERSION`, extension manifest all agree |
| `npm test` | **622 / 616 pass / 1 fail / 5 skipped** |
| `build-extension.py --verify` | current (v4.7.24 from `99c94fa`); warns the tree is dirty |
| DOM contract | 13 signals, all with `measured` blocks; `checkDomSignals()` passes |
| payload captures | **1** (`app-ungrounded-01`, 19 fields); 2 further cases not captured |
| node | v26.7.0 (package requires ≥22) |

### The safety argument that constrains every capture here

`classifyString` in `extension-cloudflare/injected.js` consults a fixed prefix
allowlist — `notebook://`, `http(s)://`, a bare UUID, `boq_`, or a string that
parses as JSON — and returns `OPAQUE` with nothing retained for everything else,
prompts included. The canary in `payload-classifier.test.mjs` fails the moment
anyone adds a prefix, substring, hash or first-N to the output, which is the
only route by which this could begin leaking.

Every fixture and every diagnostic record written under this plan inherits that
guarantee **only if it goes through that function**. A record transcribed by
hand from a Kapture network body is not covered by it — the raw body contains
the prompt, the `at` CSRF token, and the session id. So the rule for Phases B
and D alike: sanitized structures come from `PAYLOAD_PROBE` records read out of
the console; raw network bodies are read, compared against the probe record, and
**never written down**. `f.sid`, `_reqid`, `at` and cookies are session-derived
and change per page load, so recording them would record noise that has expired
by the time anyone reads it.

## Types

No type declarations exist in this codebase: plain JavaScript (ESM in the
worker, IIFE with `module.exports` in the extension) plus Python 3 for the build
script. The shapes below are the data contracts this plan adds. All are plain
JSON-serialisable objects carried in fixtures or message fields — no new runtime
type machinery.

### `SubmitDiagnostic` — new, one observation from a failed submit

The record that makes KAN-242 diagnosable. Emitted when `typeAndSend` reports
success but no `StreamGenerate` is observed within a short window. Structural
only, never prompt text.

```js
{
  requestId: "req_<uuid>",
  capturedAt: "2026-10-02T…Z",
  case: "fresh-0-turn" | "short-1-turn" | "long-2plus-turn",
  // What the page looked like at each step of typeAndSend.
  step: {
    fill:       { landed: true, attempts: 2, editorLength: 749, qlBlank: false },
    sendButton: { found: true, disabled: false, matches: 1 },
    confirm:    { userQueriesBefore: 3, userQueriesAfter: 4, rose: true }
  },
  // The discriminator. streamGenerateSeen is the whole point of the record:
  // `rose: true, streamGenerateSeen: false` is the state that is currently
  // invisible to the bridge and is the prime suspect.
  streamGenerateSeen: false,
  // Proportional counts only — never text, never tokens (GUARDRAILS G1.2.1).
  dom: { modelResponses: 2, sourceChips: 0, pendingRequest: 1, thinkingDots: 1 },
  attach: { attempted: true, ok: true, step: "select", attachedCount: 14 },
  chipPresentBeforeSend: true
}
```

`case` is a closed set, because the comparison is the entire point: a record
whose `case` is a free string can be filed as "long" without saying how long, and
the correlation with turn count is exactly what needs to be established.

The two fields that carry the diagnosis are `step.confirm.rose` and
`streamGenerateSeen`. Read together they separate state 3 (click did nothing)
from states 1, 2 and 4 without needing any further capture.

### `SubmitProbeRecord` — new, the in-page observation

The extension-side shape written by `injected.js` when it sees a
`StreamGenerate` or `batchexecute` request during a submit window.

```js
{
  requestId: "req_<uuid>",
  endpoint: "StreamGenerate" | "BatchExecute",
  transport: "fetch" | "xhr",
  buildLabel: "boq_assistant-bard-web-server_20260929.03_p0",
  // Timestamps only. Never the URL query — it carries `at`, `f.sid` and
  // `_reqid`, all session-derived and all expired by the time anyone reads
  // this (G1.1.2: first-party tokens must not leave the browser).
  observedAt: 1758000000000,
  // The existing sanitized fingerprint, reused verbatim from
  // decodeAndSanitizePayload → extractBoundedStructure. Not re-derived.
  structure: [ /* extractBoundedStructure output */ ]
}
```

This reuses `decodeAndSanitizePayload` rather than adding a second decoder. The
project's own history is that a second source of truth about a payload is the
defect class that keeps recurring — the DOM contract, the `/v1`–`/v2` handler,
and the `f.req` builder itself are all instances of it.

### `PayloadCapture` — carried over from the superseded plan, with one change

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

**The case set is three, not four.** The superseded plan listed
`ungrounded-notebook` as a fourth case. `1a872d6` measured that the notebook page
does not host a conversation at all — asking there issues `GET /notebook/…` and
then `GET /app`, spawning a new conversation under `/app/<new-id>`. Every
conversation that has ever carried a notebook reference therefore lives under
`/app`, and the notebook reference is a property of the **chip**, not of the
page. So the comparison the measurement actually needs is chip-present versus
chip-absent *within* `/app`, which is what the three cases above are.

Keeping the obsolete fourth case in the closed set would be the same defect as
planning a capture of a surface that cannot exist: it would let a fixture appear
under a name that means nothing. The existing fixture's `case` value
`ungrounded-app` is renamed to `app-chip-absent` when the second capture is
added, and the rename is noted in the fixture's own `_note`.

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
capture can say which, and the judgement is recorded rather than inferred.

## Files

### New

**`cloudflare-worker/tests/submit-diagnostic.test.mjs`**

Pins the KAN-242 diagnosis logic in isolation, against stub documents, before
any live run. Asserts that `typeAndSend` distinguishes "the click did nothing"
from "the click worked", because that distinction is currently absent and is
the whole defect. Written **before** the fix, so it fails first.

**`cloudflare-worker/tests/fixtures/submit-diagnostics.json`**

The measured records for KAN-242, one per `case` in the closed set. Sanitized:
counts, lengths, booleans, step names. No prompt text, no answer text, no
tokens.

**`cloudflare-worker/tests/payload-shape-contract.test.mjs`**

Pins the payload fixtures and asserts the worker builder still produces what the
captures say the endpoint expects. Deliberately written so that its divergence
assertion **fails today** — the whole finding is that they differ — with the
divergence enumerated in the message rather than merely flagged. A test that
passes while documenting a known divergence teaches the next reader to skip it.

Once the team decides whether a direct send is pursued, this test either gains a
fixture for a corrected builder or is deleted. Either is fine; leaving it green
while the shapes differ is not.

**`scripts/analyze-payload-shape.mjs`**

The diff. Reads the captures, reduces each to a flat `StructureField` list, and
prints where the worker's builder and the observed payload disagree — by index,
kind and class. Exits non-zero when they describe incompatible shapes, so it can
be wired into CI later if the team decides to hold that line.

It reads `cloudflare-worker/src/index.js` for the builder rather than
duplicating it. A script carrying its own copy of the layout it is checking is a
second source of truth, which is the defect class this project keeps
rediscovering.

**`docs/NOTEBOOK-API-FEASIBILITY.md`**

The assessment. Not a design document — an accounting of what was measured, what
it implies, and what remains unknown. Five sections: what was measured with
capture ids; the field-by-field divergence; the context block (what is known,
how its size moves, whether any structure was recoverable); session requirements
and what they rule out; a verdict on reachability with the evidence for it.

The verdict is allowed to be "not reachable", and on current evidence likely is.
A document concluding the direct path is closed is a **successful** outcome of
this phase; one concluding it is open on the strength of an unexamined 2 KB
string is not.

### Modified

**`cloudflare-worker/tests/production-host.test.mjs`** — add
`SESSION_HANDOFF_2026-10-01.md` to `HISTORICAL_ALLOWLIST` with the reason "names
the retired host explicitly as a trap to avoid, same as the 2026-09-30 handoff
above it". The file already warns the reader at the top, which the neighbouring
`every allowlisted file warns the reader` test verifies once it is listed.

**`SESSION_HANDOFF_2026-10-01.md`** — two corrections, both factual:

1. §1 says `tests 619 / 608 pass / 0 fail`; the true count at `11524c2` is
   622 / 616 / **1 fail**. Correct it rather than leaving a number that will be
   read as reassurance.
2. §10 orders "push 2 commits" second and does not mention that the suite is
   red, or that three commits are unpushed (`20d2e01` is also local). Correct
   the ordering to match Phase A.

**`CHANGELOG.md`** — one `[Unreleased]` entry under `### Fixed` for the KAN-242
root cause and its fix, and one under `### Added` for the fixtures. Under
`### Fixed` because a real production failure stops happening; the KAN-236
assessment, if it lands, goes under `### Added` as documentation.

**`PLANNING-HANDOFF.md`** — record whatever KAN-242 diagnosis finds, in the form
GUARDRAILS G4.1.1 requires for unfinished work. No `TODO`/`FIXME` markers in
`cloudflare-worker/src/` or `extension-cloudflare/` (G4.1.1) — if the diagnosis
reveals something that cannot be finished now, it goes here.

**`extension-cloudflare/prompt-typing.js`** — see Functions. The change is
confined to `typeAndSend`'s confirmation step and depends on what the diagnosis
finds.

**`extension-cloudflare/injected.js`** — add the submit-window probe. Gated by
the same runtime-flag pattern as `PAYLOAD_PROBE_SET`, console-only sink for the
same GUARDRAILS G1.2.1 reason, defaulting to off. **No URL, no query string, no
headers** — `matchRecognizedEndpoint` already returns only
`{endpoint, canonicalPath, buildLabel}`, and that is all the new record carries.

**`cloudflare-worker/src/index.js`** — `collectTypedAnswer` only, and only after
the KAN-242 fix, because both changes concern the same failure and shipping them
separately would make the changelog untellable.

### Not touched

**The `f.req` builder at `cloudflare-worker/src/index.js:150-159`** — it is the
*subject* of the Phase D measurement, not its object. Changing it blind is what
produced KAN-182's workaround in the first place.

**`extension-cloudflare/content.js`** — `handleTypePrompt` and
`handleCollectAnswer` are correct as written. The defect is in what
`typeAndSend` asserts, not in how these read its result.

**The payload probe's console-only sink** — correct under G1.2.1 and
load-bearing: the console is the only sink that cannot persist anything.
Fixtures are produced by an operator reading the console, not by giving the
probe a disk sink.

**`prompts/`** — seven untracked files with an uncommitted README whose central
claim ("splitting does not weaken the analysis") is contradicted by the
measurements above it. It stays untracked. Deciding its fate is a separate task
that needs its own evidence, not a footnote to this one.

## Functions

### New: `describeSubmitState(doc, probeRecord)`

`extension-cloudflare/prompt-typing.js`. Pure classification of the submit
window from two inputs: the DOM after `typeAndSend` returns, and the probe
record (or its absence). Returns one of:

`"request_issued"` · `"transcript_grew_without_request"` ·
`"editor_did_not_hold"` · `"no_send_button"` · `"no_record_yet"`

`"transcript_grew_without_request"` is the state that is currently
indistinguishable from success, and naming it is the point of this function.
`doc` and `probeRecord` are injected so the whole matrix is testable with stubs
and no browser.

### New: `waitForSubmitSignal(requestId, timeoutMs)`

`extension-cloudflare/prompt-typing.js`. Waits for a `SUBMIT_PROBE` message from
the MAIN world within a short window — 3 s is the working figure, since the
network call is issued synchronously with the click. Resolves `null` on timeout
rather than rejecting, because "nothing observed yet" is a legitimate answer and
must not throw.

If the diagnosis shows the click is reliable and only the *answer* is missing,
this function is deleted instead of shipped. The plan does not assume it will
survive.

### New: `handleSubmitProbe(msg)`

`extension-cloudflare/content.js`. Receives `SUBMIT_PROBE` from the MAIN world,
tags it with `requestId` and `case`, appends it to the in-page diagnostic
buffer, and — when `case` is set — sends the whole `SubmitDiagnostic` to the
worker along with `TYPE_PROMPT_RESULT`. A pure pass-through otherwise.

### New: `probeRecordForSubmit(matched, transport, requestStructure)`

`extension-cloudflare/injected.js`. Wraps the existing
`probeRecord(...)` / `logProbeRecord(...)` pair to also emit a `SUBMIT_PROBE`
`postMessage` while a submit window is open. Reuses `decodeAndSanitizePayload`
and `extractBoundedStructure` unchanged.

### New: `recordSubmitDiagnostic(record)`

`cloudflare-worker/src/index.js`. Appends the sanitized `SubmitDiagnostic` to a
bounded ring buffer on the DO instance and makes it readable via
`check_bridge_health`. Five entries is enough — one per turn — and storing the
last few failures is what turns "it failed again" from an unreproducible report
into a comparison.

### New: `flattenStructure`, `describeWorkerBuilder`, `diffShapes`, `assessReachability`

All four in `scripts/analyze-payload-shape.mjs`, carried over unchanged from the
superseded plan. One refinement: `describeWorkerBuilder` matches on the
`// โครงสร้าง f.req array ของ Google Web RPC` comment plus the enclosing
`return JSON.stringify([null, …])`, and **fails loudly** when it cannot find
them rather than returning an empty list — because "found nothing" and "found
nothing to compare" would otherwise look identical, which is the exact failure
mode of a measurement tool reporting no differences.

### Modified: `typeAndSend(opts)`

`extension-cloudflare/prompt-typing.js`. The change is confined to the
confirmation step, and **what it becomes depends on the Phase B diagnosis**:

- **State 3** (transcript grew, no request): replace the `countUserQueries`
  check with `describeSubmitState(...)` and fail fast with
  `prompt_not_submitted_reason=transcript_grew_without_request` instead of
  reporting `ok: true` and waiting 120 s for an answer to a request never made.
  This alone converts a 120-second timeout into an immediate, accurate error,
  whatever the underlying cause turns out to be.
- **States 1 and 2**: these already fail with `prompt_text_not_applied` /
  `send_button_not_found`; the fix is upstream in the editor or button handling
  and the diagnostic is what identifies which.
- **State 4**: nothing changes here, and the fix belongs in Phase C's timer work
  or is recorded as a Gemini-side behaviour.

In every case `responsesBefore` continues to be sampled **before** the click. It
is the attribution baseline and KAN-182 depends on it.

### Modified: `collectTypedAnswer({ requestId, timeoutMs, responsesBefore })`

`cloudflare-worker/src/index.js:2152`. Two known-incomplete items from
`[4.7.24]`, both real and both fixed here — *after* the KAN-242 change and in
the same commit, so the changelog describes one failure rather than two:

1. The flat 120 s timer becomes idle-aware, mirroring the split
   `waitForResponseChange` already uses on the extension side. The hard cap
   stays, so a page stuck showing a spinner forever still fails rather than
   hangs.
2. `lastCollectedResponseCount` is read on the timeout path although it is only
   written when a `COLLECT_ANSWER_RESULT` arrives — so it is always `0` there,
   and the message reports `responses on screen=0` when the page held 5. The fix
   is a periodic count message from the extension while collection is in flight,
   so the number is live rather than remembered.

Neither of these fixes KAN-242. They are in this plan because they are already
diagnosed, already documented as incomplete, and sitting in the same code path a
reader will be looking at. Doing them here rather than leaving them for a third
session is the point.

### Modified: `classifyString(str)`

`extension-cloudflare/injected.js`. **Not yet** — one specific change, gated on
the Phase D chip-absent capture confirming the hypothesis:

`STRING_CLASS.NOTEBOOK_REF` matches `"notebook://"`, with a scheme separator. The
payload carries `"notebooks/"`, without one, so a notebook reference classifies
as `OPAQUE`. That is why KAN-195 could see only a *length* difference between
grounded and ungrounded captures — the one bit that would have settled it was
being thrown away by the classifier.

The fix is to match the prefix actually on the wire. It is gated because it is
currently a **hypothesis**, and widening an allowlist that is the last thing
standing between a prompt and a persisted fixture is exactly the change that
should not be made on a hunch. The canary in `payload-classifier.test.mjs` must
be re-run and must still fail on any attempt to retain content.

### Removed

None. `sendButtonFallback` is the one candidate — see Phase E — and even there
the plan is to record the evidence and decide, not to delete on a hunch.

## Classes

None added. None removed.

The worker exposes one Durable Object class (`GeminiBridgeDO`,
`cloudflare-worker/src/index.js`) and the extension uses IIFEs with a registry
`Map` (`extension-cloudflare/model-adapter.js:17`). Everything this plan adds is
procedural: four functions in `scripts/analyze-payload-shape.mjs`, four in the
extension files, one bounded ring buffer on the DO instance.

`GeminiBridgeDO` gains **data**, not behaviour: `this.submitDiagnostics`, a
5-entry ring of sanitized `SubmitDiagnostic` records, and one line in the health
payload exposing it. Nothing about how it executes changes.

## Dependencies

**None added.** No package changes, no version bumps. This plan adds a JSON
fixture, one analysis script, and four functions to files that already exist.

The script uses `node:fs`, `node:path` and `node:url` — the same three
`build-stamp.test.mjs` already uses, and the direct precedent for a script in
this repo that reads source rather than importing it. The tests use `node:test`,
`node:assert/strict` and `node:module`, matching every other file in
`cloudflare-worker/tests/`.

**Capture needs Kapture**, which is already installed and already has
`network_monitor` and `console_logs`. No new integration is introduced — and that
matters, because the capture is a browser-side act no test can perform.

**Two operational dependencies, not code ones:**

- `twg` must be authenticated for `twg jira workitem get KAN-242`. Auth comes
  from `~/.config/twg/auth.conf`; do **not** `source ~/.zshrc` to get it.
- The extension build must be current before a live run means anything:
  `python3 scripts/build-extension.py --verify`, then reload at
  `chrome://extensions`. A worker deploy does not touch the extension.

## Testing

**`submit-diagnostic.test.mjs`** — asserts the state matrix, all five branches,
against stub documents:

1. probe record present + `user-query` rose → `request_issued`
2. `user-query` rose, no probe record → `transcript_grew_without_request`
3. editor `ql-blank` after fill → `editor_did_not_hold`
4. no enabled send button → `no_send_button`
5. probe window not yet elapsed → `no_record_yet`

Case 2 is the one that matters and the one with no coverage today. It is pinned
from both directions: with the fix it must be reported as a failure, and a
mutation that makes it report `ok: true` must be observed to fail the test.

**`collect-typed-answer-deadline.test.mjs`** — extended for the idle-aware
worker timer, in the same style as the existing extension-side tests: it must
slide for a live generation and still stop for a dead one. The count-on-timeout
fix gets its own assertion: a timeout with the extension reporting 5 must render
`responses on screen=5`, not 0.

**`payload-shape-contract.test.mjs`** — four assertions, the first expected to
fail today:

1. every capture parses and names a `case` from the **three**-element closed set
2. `app-chip-present` and `app-chip-repeat` produce the same shape at the
   indices carrying the prompt and the notebook reference — this is what makes
   the first capture trustworthy rather than a one-off
3. `flattenStructure` of the observed captures and of the worker builder
   disagree at a non-empty set of indices, and the expected set is pinned so the
   day someone fixes the builder, the test says so
4. no string in any capture has a `cls` outside `STRING_CLASS`, and none retains
   its content

Point 4 restates the canary at the fixture level. `payload-classifier.test.mjs`
proves the function is safe; this proves the *output that ships* is safe, which
is the thing that actually reaches the repo.

**The analysis script's own tests** — `diffShapes` and `describeWorkerBuilder`
pinned against hand-built shapes, so a bug in the comparison is not mistaken for
a finding about the payload. This distinction is the whole point: the analysis
tool is the only thing standing between a capture and a conclusion, and it gets
tested like one.

**Mutation checks.** The project's standing practice, applied here for a
specific reason — the failure mode of a measurement plan is a tool that reports
no differences:

- make `describeSubmitState` return `request_issued` whenever `user-query` rose
  → the state-2 test must go red
- truncate `diffShapes` to the first five indices → a deliberate out-of-range
  delta in the fixture must surface
- key `flattenStructure` by bare index instead of path → nested divergence must
  stop being attributed correctly
- delete the notebook-reference field from an `app-chip-present` capture → the
  chip-present/chip-absent comparison test must fail, proving the fixtures are
  what the conclusion rests on
- replace the source-extraction failure with an empty shape → the extractor test
  must fail, because "found nothing" and "found nothing to compare" look
  identical otherwise
- add a substring to `classifyString` output → the existing canary must fail

**Stated plainly.** Nothing here verifies that Gemini behaves correctly, and
nothing here verifies that a direct call is possible. It verifies that the shape
of the real request is recorded, that the worker's builder does not match it,
and that the analysis tool reporting that is itself correct. The last of those
three is the one a reader is most entitled to distrust, which is why its
mutations are listed explicitly.

**Regression.** `cd cloudflare-worker && npm test` must go from
622/616/**1 fail** to 622/**617 pass**/0 fail. Phase A moves the pass count by
exactly one and the fail count to zero; no other phase may move the total. Any
movement beyond that is a mistake, not an improvement.

## Implementation Order

### Phase A — Risk, before anything else (≈20 min, no code)

Everything here is already-done harm being tidied, and none of it needs a
browser.

1. **Rotate the GitHub PAT.** It leaked into a transcript while inspecting a
   config file. Revoke the old one and issue a new one; do not print the new one
   either. Highest priority in this plan precisely because it is the only item
   where the damage is already done and still growing.
2. **Verify KAN-242 exists** — `twg jira workitem get KAN-242`. If it does not,
   create it and use the returned key. Every later commit cites this.
3. **Make the suite green.** Add `SESSION_HANDOFF_2026-10-01.md` to
   `HISTORICAL_ALLOWLIST` in `production-host.test.mjs` with its reason. Re-run
   `npm test`; expect 617 pass, 0 fail.
4. **Correct the two factual errors** in `SESSION_HANDOFF_2026-10-01.md` §1 and
   §10 (test counts; push ordering).
5. **Push the three commits.** `cd cloudflare-worker && npm test` first — the
   governance rule is 0 fail, so this is now satisfied. `pre-push` will ask Jira
   about KAN-236 on all three, which is correct and should pass.

Nothing else starts until this phase is done and the tree is clean.

### Phase B — Diagnose KAN-242 (needs a focused Gemini tab)

**Measure first. This phase produces a record, not a fix.**

6. Build the extension if the source moved, `--verify`, reload at
   `chrome://extensions`.
7. Enable the submit probe. Run `horo_consult` against **three** conversations
   in order: a fresh `/app`, a 1-turn conversation, and a 2+ turn conversation.
   Read the `SubmitDiagnostic` from `check_bridge_health` after each.
8. Clear the Kapture network buffer **before** each run and read it in
   intervals, not once at the end — the previous session's missed capture came
   from reading it once. The buffer rotates at 2000 entries.
9. Fill `submit-diagnostics.json` with one record per `case`.
10. **State the root cause in one sentence, and stop.** Four possibilities, four
    different fixes, and two of them are not fixes at all. If the evidence points
    at state 4 — the request went out and Gemini declined — then the typed path
    is behaving correctly and the problem is upstream in Gemini, which is a
    finding to record, not a defect to patch.

If the three conversations cannot be produced on demand, record that as the
finding and stop. A fabricated `submit-diagnostics.json` is worse than an absent
one, and the project's own history has three wrong conclusions in a row from
incomplete data.

### Phase C — Fix KAN-242 and the two known-incomplete timers (≈half a day)

11. Write `submit-diagnostic.test.mjs` **first**, against the state matrix. It
    passes for states 1, 3, 4, 5 and fails for state 2 until the fix lands.
12. Implement `describeSubmitState`, `waitForSubmitSignal`, `handleSubmitProbe`,
    `probeRecordForSubmit`, `recordSubmitDiagnostic`.
13. Apply the `typeAndSend` fix for whichever state Phase B identified.
14. Make `collectTypedAnswer`'s timer idle-aware, with the hard cap retained;
    add the live response count so the timeout message stops printing 0.
15. Extend `collect-typed-answer-deadline.test.mjs` for both.
16. Run the two Phase C mutations. Each observed to fail, then reverted.
17. `CHANGELOG.md` under `[Unreleased]` → `### Fixed`. **One entry covering the
    root cause** — not three entries describing three symptoms of it.
18. **Live verification before deploying.** Reload the extension, run the 2+ turn
    conversation that reproduces the failure, confirm it now either succeeds or
    fails fast with an accurate reason. A worker deploy does not carry an
    extension change, so the extension must be reloaded and the run repeated with
    both sides current. Only then bump the version and deploy.

### Phase D — Finish the KAN-236 measurement (needs a focused Gemini tab)

19. Capture the **chip-absent** half: an `/app` turn with no chip attached.
    `horo_consult` can never produce this — attaching is its job — so it is a
    manual ask with the probe enabled.
20. Capture the **chip-repeat** half: a second turn in the same conversation, to
    see whether the context block grows within one conversation rather than only
    across conversations.
21. Transcribe both **verbatim** from `extractBoundedStructure` output. Never
    from a raw network body.
22. Write `payload-shape-contract.test.mjs` assertions 1, 2 and 4. These should
    pass. If they do not, the capture was transcribed wrong and the answer is to
    re-read the console, not to relax the assertion.
23. Build `scripts/analyze-payload-shape.mjs` — `flattenStructure`, then
    `describeWorkerBuilder`, then `diffShapes`. Unit-test the first and third
    before wiring the second to the real source.
24. Run the diff and **write down what it says** before deciding what it means.
25. Characterise the context block across the captures: does its length move
    with turn count, with the page, or not at all? A block byte-identical across
    a one-turn and a six-turn conversation is not conversation state.
26. Add assertion 3 and confirm it fails **for the reason stated in the assertion
    message**. A different failure means the tool is wrong and step 23 is not
    finished.
27. Only now: if step 25 shows the context block is reconstructible from known
    inputs, change `classifyString` to match `"notebooks/"` and re-run the
    canary. If it does not, leave the classifier alone and record why.
28. Write `docs/NOTEBOOK-API-FEASIBILITY.md`. Steps 19–26 are its evidence; the
    verdict comes last and may be negative.

### Phase E — KAN-231 fixture gap (≈30 min, no browser)

29. `sendButtonFallback` matched **zero** elements in every captured state,
    including the one where the primary selector found an enabled button. The
    DOM contract already records this honestly as `observed: false` with
    `unobservedBecause`. The gap is that it stays in `prompt-typing.js` as a
    fallback that provides none.
30. Decide with evidence, and record the decision either way:
    - capture a state on another Gemini build where it does match → it stays,
      now honestly earned; or
    - confirm it matches nothing anywhere reachable → remove it and drop
      `prompt.send_button_fallback` from the contract, so the corpus stops
      carrying a signal that is decoration.
31. `prompts/` — leave untracked. Its README asserts "splitting does not weaken
    the analysis" directly above the measurement that contradicts it. Deciding
    its fate needs its own evidence, not a footnote here.

### Phase F — Close out

32. Full suite: **617 pass, 0 fail, 5 skipped**, total 622 unchanged.
33. `node --check` on every touched JS file.
34. `python3 scripts/build-extension.py --verify` current.
35. `PLANNING-HANDOFF.md` updated with whatever remains open — the KAN-236
    verdict if it is negative, the KAN-231 decision if unresolved, and anything
    Phase B could not determine.
36. Report the measured numbers, not the expected ones. If something did not
    work, say so here rather than in a commit message nobody reads.

### What each phase needs

| phase | operator | browser | `npm test` |
| :--- | :--- | :--- | :--- |
| A risk | yes (Jira, PAT) | no | must go 617/0 |
| B diagnose | yes | **yes** | no |
| C fix | no | yes, for live verification | adds tests |
| D measure | yes | **yes** | adds tests |
| E fixtures | yes (one capture) | possibly | changes contract |
| F close | no | no | 617/0 |

Phases B and D need a focused Gemini tab and cannot run in parallel — both drive
the same tab. Phase C's steps 11–16 need neither and can be done while waiting.

The plan halts at Phase D step 28. It does not attempt a direct
`StreamGenerate` call, because reaching one needs the verdict from step 28
first, and the measured fact that the request is session-bound points at keeping
the browser in the loop and replacing only the DOM scraping — a smaller change
than the one this plan is scoping, and the one to evaluate next.
fixable from the bridge at all.