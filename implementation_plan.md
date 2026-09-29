# Implementation Plan

**Goal:** Close out the replay-path question left open by KAN-195 — determine
whether the notebook reference is present in the request payload, using a
capture that is safe under GUARDRAILS G1.2.1, then correct every document that
states the opposite.

## Overview

KAN-195 captured two sanitized `StreamGenerate` structures and produced a
finding that contradicts the project's own architecture record. The two samples
differ in exactly one top-level field, and only in its **length**; the slot
`ARCHITECTURE.md` names as the `r_…` session token is a zero-length string in
both. Grounded sample A and ungrounded sample B are the same shape.

That result cannot be acted on, because a sanitized capture reduces every
string to `{type:"string", length:N}`. A length difference cannot be attributed:
two different values can share a length, so "field `[3]` changed" does not tell
us whether the notebook reference is in it, absent, or replaced by something
else of similar size. The stated hard limit in
`docs/payload-samples/2026-09-29-streamgenerate.json` is correct.

This plan changes the capture so the limit no longer applies, runs the one
experiment that decides the question, and then rewrites the documentation to
match the measured result — whichever way it lands.

Scope is `injected.js` (the sanitizer and the probe) plus documentation. No
worker logic changes, no protocol changes, no new dependencies. The existing
grounded path is not touched.

### Why classification is safe, and why it is enough

The current sanitizer records a string's length. The change is to additionally
record which **closed-set class** a string belongs to, using a fixed allowlist
### What the two existing samples cannot do

Sample A and sample B were captured with the length-only sanitizer. Their
content was discarded at capture time and **cannot be re-classified
retroactively** — the class was never computed and the strings are gone. Any
conclusion about classes requires a fresh capture. This is why the plan
captures a new pair rather than reusing the existing file, and why steps 7–8
re-capture both members of the comparison instead of only the grounded one.

### The experiment, and how it decides

Two captures from the **same conversation**, consecutive turns:

- **C** — fresh conversation, turn 1, notebook attached. Expected: grounded.
- **D** — same conversation, turn 2. The attachment is consumed per message,
  so this turn carries no fresh chip. Expected: ungrounded.

Same conversation removes conversation age as a variable, which the existing
A/B pair confounded: A was a mature conversation, B was a fresh one, so their
difference cannot be attributed to the chip rather than to accumulated
context. Consecutive turns also keep the context blob similar in size, so a
large length delta is not mistaken for the signal.

Decision rule, applied to the class-level diff of C against D:

| Observation | Conclusion | Consequence |
|---|---|---|
| C contains a `notebook_ref` class that D does not | the payload **does** carry the notebook reference; shape is more derivable than the record claims | replay construction is a real engineering problem, scoped separately; the "never grounded" claim is falsified |
| C and D are class-identical | payload shape does **not** determine grounding; the determining state is server-side and outside the capture | replay is permanently out of scope for grounding; the record's **reason** is replaced, its conclusion stands |
| C is itself ungrounded | the fresh-conversation path does not ground, and C is not a grounded sample | stop; the blocker is upstream of the payload and the next step is a Gemini-side investigation, not more capture |

All three outcomes are recorded. The third is a real possibility and the plan
does not assume it away.

### Context and constraints

- `GUARDRAILS.md` G1.2.1 — prompt text never persisted.
- `GUARDRAILS.md` CSRF rule — "the CSRF token must never leave MAIN-world
  memory". The probe never touches `activeCsrfToken`; it dumps
  `requestStructure`, which is derived from the request body but contains no
  token field.
- Version consistency is enforced by
  `cloudflare-worker/tests/version-consistency.test.mjs` across 5 source
  locations plus the build output — a bump touches all of them together.
- `scripts/build-extension.py --verify` must pass before any live result is
  believed; a stale build has silently invalidated a live run once already
  (KAN-192).
- Reloading the extension invalidates every content script, so a Gemini tab
  reload is required after. Two manual steps the operator performs; the plan
  does not attempt to automate them.
- Delegation tooling (`agy-run`, `agy-quota`) and 9 skills exist under `~/`
  and may be used for the test-authoring step. `agy-run --mode worktree` is
  the isolation path; agy accounts have no native worktree flag, so
  `agy-run` creates one.


of shapes that are defined by the protocol rather than by the user:

- a string beginning `notebook://` is a notebook reference
- a string beginning `http://` or `https://` is a URL
## Types

No type declarations exist in this codebase — it is plain JavaScript (ESM in
the worker, IIFE-with-`module.exports` in the extension) and Python 3 for the
build script. The type-like contracts below are the object shapes that cross
module boundaries.

**`StringClass` — new closed enum, `extension-cloudflare/injected.js`**

```js
const STRING_CLASS = {
  NOTEBOOK_REF: "notebook_ref",   // starts with "notebook://"
  URL:         "url",            // starts with "http://" or "https://"
  UUID:        "uuid",           // /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  BUILD_LABEL: "build_label",    // starts with "boq_"
  JSON_BLOB:   "json_blob",      // first char is "[" or "{" and JSON.parse succeeds
  OPAQUE:      "opaque"          // everything else — includes the user's prompt
};
```

Six members, fixed. Adding a member is a reviewable change because each one
names a protocol shape.

**Sanitized string — changed shape, `extractBoundedStructure` output**

```js
// before
{ type: "string", length: 349 }
// after
{ type: "string", length: 349, cls: "opaque" }
```

`length` is retained. Bucketing it is unnecessary: length is not user text, it
is already in the current artifacts, and exact lengths are what let C and D be
compared at all. `cls` is additive, so every consumer that ignores it keeps
working.

**Probe record — new, written to the page console only**

```js
{
  endpoint: "StreamGenerate" | "BatchExecute",
  transport: "fetch" | "xhr",
  buildLabel: string | null,
  sessionEpoch: string,
  canonicalModelId: string | null,
  structure: { outerLength: number, hasEnvelope: boolean, structure: unknown }
}
```

Unchanged from the KAN-195 probe. It is deliberately not routed to the content
script or the worker: the console is the only sink that cannot persist anything,
and that property is what made the KAN-195 capture acceptable.

## Files

### New

**`cloudflare-worker/tests/payload-classifier.test.mjs`**

Pins the classifier and, more importantly, pins the guarantee that no user text
survives it. 12 cases, listed in the Testing section.
**`ARCHITECTURE.md`**

- §"Why the replay path can never be grounded" (line 232) — rewritten. The
  current text asserts an `r_…` token that is "single-use" and "~40 dynamic
  inner fields"; both are contradicted by the measurements. Replaced with the
  measured result and the outcome from the decision table.
- §"Replay Path vs Grounded Path" table (line 227) — the "When to use" and
  "Grounding" cells are retained; the *reason* is corrected. The bifurcation
  itself is not in question and the CAUTION block at line 240 stands.
- Line 66 diagram — "Model Adapter Replay Payload Construction" stays; the path
  still exists and is still reachable for stateless text.

**`cloudflare-worker/src/index.js`**

- Comment block at lines 1657–1672 — its reasoning ("replay posts the bare
  prompt, with no `notebook://…` reference") is wire-verified from KAN-182 and
  independent of the `r_…` claim. Left substantively intact; a cross-reference
  to the corrected `ARCHITECTURE.md` section is added so the two do not drift
  again.
- `WORKER_VERSION` (line 35) and the header comment (line 3) — bumped only if
  step 12 proceeds.

**`extension-cloudflare/content.js`**

- Comment at line 1345 states the replay payload "is built from a schema Google
  has since changed". That claim is about rejection, is supported by the
  KAN-182 wire capture, and stays. A cross-reference is added.

**`docs/payload-samples/2026-09-29-streamgenerate.json`** — one factual defect
to fix: `findings[2]` records the token slot as `[0][2][0][0][3]`. The correct
path is `inner[0][3][0][0][3]`. This was corrected in the handoff document
during KAN-195 and missed here. Verified by re-running the path against the
stored structure before the edit.

**`docs/HANDOFF-NEXT-SESSION.md`**

- §9 — append the KAN-196 outcome alongside the KAN-190…195 table.
- §10.1 — replace the blocker text; it is resolved by this work or explicitly
  re-scoped by its third outcome.
- §10.2 — drop the "reconcile ARCHITECTURE.md" row once step 11 lands.

**`CHANGELOG.md`** — one entry for the classifier and one for the corrected
record.

**Version locations, bumped together in step 12 only** —
`cloudflare-worker/src/index.js:3` and `:35`, `cloudflare-worker/package.json:3`,
`cloudflare-worker/package-lock.json:3` and `:9`,
`extension-cloudflare/manifest.json:4`. The build produces the sixth, in
`dist/extension/manifest.json`.

### Not touched

- `cloudflare-worker/src/index.js` control flow — the typed path, the
  `requireGrounding` routing (line 1700), and the grounding verdict (line 3672)
  are correct as they stand.
- `model-adapter.js` — `buildReplayPayload` (line 134) consumes a string; the
  class annotation is additive and invisible to it.
- `evidence-registry.js` — stores `requestSignature` opaquely; unaffected.
- `scripts/build-extension.py`, `.gitignore`, CI workflows.

## Functions
### Modified: `extractBoundedStructure(val, depth = 0)`

`extension-cloudflare/injected.js:387`. The string branch (line 395) becomes:

```js
if (typeof val === "string") {
  return { type: "string", length: val.length, cls: classifyString(val) };
}
```

Every other branch — depth cap at 6, the 20-element array slice, the 20-key
object slice, the number/boolean/null/undefined handling — is unchanged. The
recursive call sites (lines 400, 406) need no edit.

### Modified: `XMLHttpRequest.prototype.send` and `window.fetch`

`extension-cloudflare/injected.js:420` and `:499`. Each gains a guarded probe
call immediately after `requestStructure` is computed and before the response
is awaited, so a slow response cannot delay or reorder the record:

```js
if (payloadProbeEnabled) {
  console.log("PAYLOAD_PROBE " + JSON.stringify(
    probeRecord(matched, "fetch", requestStructure, modelIdAtRequestTime)));
}
```

### Unchanged, verified not to need edits

- `decodeAndSanitizePayload` (`:353`) — return shape grows a nested key only.
- `buildReplayPayload` (`model-adapter.js:134`) — takes and returns strings.
- `validateModelEvidence` (`model-adapter.js:80`) — its validator inspects
  `sig.hasEnvelope`, `sig.outerLength`, and `Array.isArray(sig.structure)`
  (line 33); none of those are touched.
- `readGroundingEvidence` (`notebook-attach.js:488`) — reads the DOM, not the
  payload.

### Classes

None. The codebase is procedural throughout: the worker exposes a Durable
Object class (`GeminiBridgeDO`) and the extension uses IIFEs with a registry
`Map` (`model-adapter.js:17`, `schemaValidators`). No new class, and no
existing class signature changes.

## Dependencies

None added. No package changes, no version bumps of existing packages, no new
runtime or dev dependencies. `node:test`, `node:assert/strict`, `node:vm`,
and `node:fs` are already used by the test suite; the classifier is six prefix
and regex tests over built-in string methods.

The only integration requirement is the one the project already has: the
operator reloads the extension at `chrome://extensions`, then reloads the
Gemini tab. Neither is automatable here — Kapture cannot reach
## Testing

**New file `cloudflare-worker/tests/payload-classifier.test.mjs`**, run by the
existing glob `node --test 'tests/**/*.test.mjs'`. Loaded via
`createRequire(import.meta.url)` against `../../extension-cloudflare/injected.js`,
matching the pattern in `extension-injected.test.mjs:13`.

Cases:

1. A `notebook://notebooks/<id>/sources/<uuid>` string classifies as
   `notebook_ref`.
2. An `https://` string classifies as `url`; `http://` likewise.
3. A bare UUID classifies as `uuid`.
4. A `boq_…` string classifies as `build_label`.
5. A string that is valid JSON classifies as `json_blob`; a string opening with
   `[` that is **not** valid JSON classifies as `opaque` — this is the case
   that would otherwise misfile a prompt.
6. A Thai-language prompt classifies as `opaque`.
7. **The canary test.** Serialize the output of `extractBoundedStructure` over
   a fixture payload containing a distinctive Thai prompt, then assert the
   prompt's text appears nowhere in the serialized result. This is the test
   that makes the guardrail claim checkable rather than asserted, and it is
   the one that must fail if anyone later adds a prefix or substring to the
   output.
8. `decodeAndSanitizePayload` on a real-shaped `f.req` body returns structures
   in which every string node has a `cls`, and the shape is otherwise
   identical to the pre-change shape — `outerLength`, `hasEnvelope`, and the
   non-string nodes are byte-equal to the current output for the same input.
9. Non-string nodes are unaffected: numbers, booleans, `null`, and `undefined`
   serialize as they did before, with no `cls` key.
10. Depth and breadth caps hold: a structure deeper than 6 yields
    `"max_depth"`, an array longer than 20 is sliced to 20.
11. `classifyString` and `STRING_CLASS` are exported on the API object and on
    `globalThis`, matching the contract test in
    `extension-injected.test.mjs:16` — which asserts the export surface is
    **exactly** the expected set, so the expected set must be extended there
    too or that test fails.
12. `payloadProbeEnabled` defaults to `false` and `handleProbeSet` ignores a
    non-boolean argument.

**Mutation checks — required before commit, following the practice used for
KAN-193 and KAN-194.** Each must be observed to fail, then reverted:

- make `classifyString` return `OPAQUE` unconditionally → cases 1–4 must fail
- add `prefix: str.slice(0, 8)` to the string branch → case 7 must fail
- widen `NOTEBOOK_REF` to match any string containing `//` → case 5 or 6 must
  fail

A mutation that does not change the result means the test is not pinning what
it claims, and the test is rewritten before proceeding.

**Regression.** Full suite `cd cloudflare-worker && npm test` — currently 459
pass / 0 fail / 5 skipped, expected to rise by 12 with 0 new failures.
`python3 scripts/build-extension.py --verify` must report current before any
live capture is believed.

**Not unit-testable, stated plainly.** Whether Gemini actually grounds the
answer is a live property. The unit tests cover classification, the guardrail,
and shape stability; the grounding outcome comes only from the step 8 capture,
and the plan does not present a green suite as evidence about it.


`chrome://extensions`.



### New: `classifyString(str)`

`extension-cloudflare/injected.js`. Returns one `STRING_CLASS` value.
## Implementation Order

1. **Classify.** Add `STRING_CLASS` and `classifyString` to `injected.js`;
   wire `cls` into the string branch of `extractBoundedStructure`. Extend the
   expected export set in `extension-injected.test.mjs:16` in the same commit,
   since that test asserts an exact surface and will otherwise fail.

2. **Test.** Write `payload-classifier.test.mjs` with all 12 cases. Run it,
   then run the three mutations and confirm each fails. Fix the test, not the
   assertion, if any mutation passes.

3. **Full suite.** `npm test` — 0 new failures. `node --check` on
   `injected.js`.

4. **Probe, gated.** Add `probeRecord`, the runtime toggle
   (`PAYLOAD_PROBE_SET` → `handleProbeSet`) defaulting to **off**, and the two
   guarded call sites. The KAN-195 probe was unconditional and hand-inserted;
   this one ships disabled and is toggled from the console, so a later capture
   costs one message rather than a rebuild and a reload.

5. **Commit and build.** Commit as `KAN-196: feat(injected): classify sanitized
   payload strings; probe behind a runtime flag`. Rebuild and confirm
   `python3 scripts/build-extension.py --verify` reports current.

6. **Operator reloads** the extension at `chrome://extensions`, then the Gemini
   tab. **Stop and wait for confirmation** — every later step depends on the
   running extension carrying this build, which cannot be verified from inside
   this process.

7. **Enable the probe.** From the page console, send
   `window.postMessage({source:"GEMINI_CONTENT", type:"PAYLOAD_PROBE_SET",
   enabled:true}, "*")`. Confirm a `PAYLOAD_PROBE` line appears on the next
   Gemini request; if none appears, the toggle did not take and the capture is
   aborted rather than run blind.

8. **Capture C.** Start a **fresh** Gemini conversation. Run
   `node scripts/ask-each-skill.mjs --tools=horo_consult`. Record the tool's
   own reported grounding verdict alongside the console structure — the two
   are independent and both are needed.

9. **Capture D.** In that **same** conversation, run `horo_consult` once more.
   The attachment is consumed per message, so this turn should be ungrounded.
   Record its structure and verdict.

10. **Disable the probe** via the same message with `enabled:false`, and confirm
    the flag took, so no further capture is possible by accident.

11. **Decide.** Apply the decision table to the class-level diff of C against
    D. Write the outcome, the diff, and the rule that produced it into
    `docs/payload-samples/2026-09-30-streamgenerate-classes.json`. This step
    is analysis of captured data and may conclude that the question is
    answered, that it is answered negatively, or that it is not answerable
    from the payload at all.

12. **Correct the record.** Rewrite the "Why the replay path can never be
    grounded" section of `ARCHITECTURE.md` to state the measured result,
    whichever branch of the table applied. Fix the `[0][2]…` path error in
    `2026-09-29-streamgenerate.json` — after re-verifying the correct path
    against the stored structure. Update the cross-references in
    `cloudflare-worker/src/index.js:1657` and `content.js:1345`. Update
    `docs/HANDOFF-NEXT-SESSION.md` §9, §10.1, §10.2. Add the `CHANGELOG.md`
    entries.

13. **Version bump, if and only if the outcome warrants a release.** 4.7.11 →
    4.7.12 across the 5 source locations. `version-consistency.test.mjs` must
    pass. Rebuild. Note that a worker-side bump additionally requires
    `npx wrangler deploy` to take effect, which touches production and is left
    to the operator; if the change is extension-only, bump the extension
    locations and say so in the handoff rather than forcing a deploy.

14. **Final verification.** Full suite, `node --check` on every changed JS,
    `--verify` on the build, `git status` clean. Report the measured test
    count rather than the expected one.

Steps 6 and 7 are the only ones that require the operator, and the plan halts
at each rather than assuming success — the stale-build and
stale-content-script failures earlier in this project were both cases of
continuing past a step whose verification was assumed rather than observed.


Order is significant and must be fixed: `NOTEBOOK_REF` before `URL` (a
`notebook://` reference is protocol-specific and must not be swallowed by a
looser prefix test), then `URL`, `UUID`, `BUILD_LABEL`, `JSON_BLOB`, else
`OPAQUE`. `JSON_BLOB` is last among the specific classes because it is the
most expensive test and the least specific — a serialized notebook reference
list is more usefully reported as a blob than as a notebook reference, and
whether it is a blob is itself the interesting fact.

`JSON_BLOB` requires `JSON.parse` to succeed, not merely a leading bracket, so
a prompt that opens with `[` is classified `OPAQUE`.

### New: `probeRecord(matched, transport, requestStructure, modelId)`

`extension-cloudflare/injected.js`, one shared body for both interceptors —
the KAN-195 version duplicated it, and the duplication is how the two copies
drifted apart in the first place. Returns the record object above or `null`
when `requestStructure` is null. Does not touch `activeCsrfToken` or any other
session state.

### New: `handleProbeSet(msg)`

`extension-cloudflare/injected.js`, registered in the §4 message bus. Sets the
module-level `payloadProbeEnabled` flag from `msg.enabled`. Accepts only a
boolean; anything else leaves the flag unchanged. Default `false`.



**`docs/payload-samples/2026-09-30-streamgenerate-classes.json`**

Samples C and D with the class-annotated structures, the class-level diff
between them, the decision reached, and the three-outcome rule that produced
it. The existing `2026-09-29-streamgenerate.json` stays as the record of what
was known on the 29th; it is corrected, not replaced.

### Modified

**`extension-cloudflare/injected.js`**

| Region | Change |
|---|---|
| §2, near `extractBoundedStructure` (line ~387) | add `STRING_CLASS` and `classifyString(str)`; call it from the string branch of `extractBoundedStructure` so the returned object gains `cls` |
| §2, `decodeAndSanitizePayload` (line ~353) | unchanged — signature and return shape preserved, so `model-adapter.js` and `evidence-registry.js` need no edit |
| §3, fetch interceptor (line ~420) | gated probe call after `requestStructure` is computed |
| §3, XHR interceptor (line ~499) | same gated probe; the prompt travels over XHR, so a fetch-only probe never sees it |
| §4, message bus (line ~537) | new `PAYLOAD_PROBE_SET` handler |
| `api` export object (line ~683) | export `classifyString` and `STRING_CLASS` so tests can exercise them directly |

**`extension-cloudflare/notebook-attach.js`** — no change. Its
`readGroundingEvidence` (line 488) already reports `chipCount` and
`citeMarkers` per response; the probe records the matching side.


- a bare UUID is a UUID
- a string beginning `boq_` is a build label
- a string that parses as JSON is a serialized blob
- anything else is opaque text — the class that covers the user's prompt

This is sufficient because the question is not "what does field `[3]` contain"
but "does any field in the payload carry a notebook reference at all". The
answer is a single bit per field, and the bit is carried by the protocol, not
by the user. GUARDRAILS G1.2.1 requires prompt text to be sanitized 100% and
forbids persisting personal text; a class label is not text, and opaque text
records only its length. The prompt lands in the `opaque` class and nothing
about it is retained.

The one rule that keeps this safe: **only the five protocol prefixes above are
ever recorded verbatim.** No arbitrary prefix, substring, hash, or first-N of
any string is stored. A prefix allowlist over a closed set cannot leak user
text, because a user prompt cannot match a protocol prefix.
