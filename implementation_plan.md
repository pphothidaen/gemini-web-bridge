# Implementation Plan

**Goal:** Turn "measure a DOM signal across both states before trusting it"
from a habit that has now been broken twice into a mechanism that fails the
build when a signal ships without its evidence.

## Overview

KAN-198 is the second time in one session that a defect reached production
because a test was written from an assumption rather than from a
measurement. The first was KAN-192: a build whose manifest said 4.7.10 while
the JavaScript beside it was older, verified by a test that asserted the
manifest string. The second was KAN-197/198: `isGenerating()` keyed on
`processing-state-visible` and `has-thoughts`, class names that read like
"currently processing" and are in fact permanent. That one shipped with ten
passing tests, three clean mutation checks, and made the bridge stop answering
altogether — `handleCollectAnswer` waited out its full 120s budget on answers
that had been finished for a minute.

Both failures share a shape. A proxy was read as the thing itself: the version
string read as the code, a class name read as a state. Neither was wrong as
data; both were wrong as evidence, because nothing in the repo required the
evidence to exist. A test can be written to agree with whatever the code does,
and the suite stays green — which is exactly what happened. The 4.7.13 tests
asserted "a finished response with only `has-thoughts` is inactive", which is
false, and the stub was constructed to satisfy it.

The fix is not more discipline. It is a requirement that is checkable: every
DOM signal declares the observation it rests on, and the build fails if one
does not. A signal without a recorded before-and-after capture is not trusted,
so the class of defect that produced both incidents cannot ship quietly.

Three things are built, in the order they can each stop the next mistake:

1. **A signal contract** — one declaration per DOM signal, carrying its
   selector, its expected value in each state, and the capture that justifies
   it. Reading a signal and consulting its evidence become the same act.
2. **A capture corpus** — real DOM snapshots, generating and settled, stored
   in the repo so the contract is checked against observation rather than
   against the code's own idea of itself.
3. **A gate on the delegation tooling** — `agy-run`'s isolation check, added
   after it silently failed once, tested so it cannot silently fail again.

The handoff document is also corrected here, because it currently names
`cd205ea` and 459 tests where the truth is `561a126` and 483, and a document
that lies about the tree is the same defect one level up.

Scope is `extension-cloudflare/`, `cloudflare-worker/tests/`, and
documentation. No worker logic changes, no protocol changes, no new
dependencies, no deployment.

### Why a contract rather than a checklist

A checklist says "observe both states before using a DOM selector". It is
followed until the day it is not, and nothing breaks when it is skipped — which
is the property that let two incidents through. A contract inverts that: the
signal and its evidence are declared together, and a signal with no evidence is
a hard failure. The cost is that adding a selector becomes a deliberate act
rather than a one-line edit, which is the point. Each of the selectors already
in the tree cost a production incident or a wasted debugging session to
validate, and none of that cost is recorded in code today.

The contract is deliberately small. It covers the signals the extension reads
out of the page — about a dozen selectors across two files — not the whole
DOM surface, and not the worker's own logic. Anything that does not read the
live page is already testable by other means.

### What counts as evidence

A capture is a pair of DOM snapshots of the same element in the two states
that matter, taken from a real browser while the state actually held. For the
generating signal that means: mid-stream, verified by the response still
growing between two samples, and settled, verified by the response having
stopped changing and the footer marked complete. One snapshot is not evidence,
which is the rule KAN-197 broke by sampling once.

Captures are stored as fixtures in the repo. They contain no user text and no
### Context and constraints

- **GUARDRAILS G1.2.1** — prompt text is never persisted. Fixtures therefore
  hold structural attributes only, never text content.
- **Version consistency** — `cloudflare-worker/tests/version-consistency.test.mjs`
  ties the worker, npm package, lockfile and extension manifest to one version
  across 5 source locations plus the build output. Any behavioural change bumps
  all of them or the suite fails.
- **`scripts/build-extension.py --verify`** must report current before any live
  result is believed. A stale build silently invalidated a live run once
  (KAN-192).
- **Two manual steps stay manual** — reloading the extension at
  `chrome://extensions` and reloading the Gemini tab. Kapture cannot reach the
  first, and it cannot type into a hidden tab reliably, which cost two failed
  attempts during the KAN-198 measurement.
- **The worker is three versions behind** (production runs 4.7.11, the
  extension is 4.7.14). Every finding since 4.7.11 was diagnosed against a
  live system but never against the deployed one. This plan does not deploy;
  it notes the gap and leaves the decision with the operator.
- **`agy-run` is outside the repo** (`~/.local/bin/agy-run`), so its test
  cannot live in `cloudflare-worker/tests/` and run by `npm test`. It is
  tested by the same source-reading technique `build-stamp.test.mjs` uses, with
  an absolute path, and that limitation is stated rather than hidden.

## Types

No type declarations exist in this codebase — plain JavaScript (ESM in the
worker, IIFE with `module.exports` in the extension) and Python 3 for the
build script. The contracts below are the data shapes that cross the boundary
between a signal and its evidence.

**`DomSignal` — new, the unit of the contract**

```js
{
  id: "response.generating",          // stable, referenced by tests
  file: "native-recovery.js",
  selector: '[aria-busy="true"]',
  scope: "newest-response",           // "newest-response" | "document" | "element"
  states: {                            // what must be TRUE in each state
    generating: true,
    settled:    false
  },
  measured: {
    date: "2026-09-29",
    fixture: "generating-signal.json",
    method: "DOM sampled across one whole generation; heights 1242px and
              3508px while streaming, footer class 'complete' once settled"
  }
}
```

`measured` is **required**. A signal without it is a build failure, not a
warning — that is the mechanism the whole plan rests on.

`scope` is explicit because the sidenav guard exists precisely because an
unscoped spinner match was read as a generation signal in KAN-177, and the
same mistake in a new selector would be invisible without it in the record.

**Fixture shape — new, `cloudflare-worker/tests/fixtures/`**

```json
{
  "signal": "response.generating",
  "captured": "2026-09-29",
  "note": "structural attributes only; no text content, no tokens",
  "states": {
    "generating": {
      "height": 3508,
      "nodes": [
        { "tag": "div", "class": "response-container-content has-thoughts" },
        { "tag": "structured-content-container",
          "class": "model-response-text has-thoughts processing-state-visible ng-star-inserted" },
        { "tag": "div", "class": "markdown markdown-main-panel md-content animate",
          "attrs": { "aria-busy": "true", "aria-live": "polite" } },
        { "tag": "div", "class": "response-footer animated gap has-thoughts" }
      ]
    },
    "settled": { "height": 4311, "nodes": [ "… same three …",
        { "tag": "div", "class": "response-footer gap has-thoughts complete" } ] }
  }
}
## Files

### New

**`cloudflare-worker/tests/helpers/dom-signal.mjs`**

The contract itself: `DOM_SIGNALS` (the declarations), `checkDomSignals()`
(produces a `DomSignalReport`), and `buildStubFromFixture(fixture, state)` —
a minimal DOM stub built from a captured fixture. The stub builder is the piece
that matters: it means tests are written against a real capture by
construction, so a test cannot quietly drift into asserting the code's own
behaviour.

`buildStubFromFixture` supports exactly the selector forms the extension uses
(`tag`, `.class`, `tag.class`, `[attr="v"]`, `tag[attr*="v"]`, comma lists) and
returns `false` for anything unrecognised rather than a hopeful `true`. That
is deliberate: the KAN-198 stub silently failed to match
`div.loading-content-spinner-container` and two tests failed for the wrong
reason, which is how a matcher becomes a thing that hides problems.

**`cloudflare-worker/tests/fixtures/generating-signal.json`**

The capture already taken during the KAN-198 measurement, transcribed. Both
states, structural attributes only. This is the fixture the shipped
`response.generating` signal is checked against, so it is the evidence that the
4.7.14 fix rests on — currently living only in a test file's comments and in
this conversation.

**`cloudflare-worker/tests/fixtures/grounding-chips.json`**

A capture for the second unmeasured signal: `readGroundingEvidence` in
`notebook-attach.js` reads `source-inline-chip` and counts `[cite: N]`
markers. Both were introduced in KAN-182 and KAN-177 respectively and neither
has a recorded before-and-after capture. The fixture records a settled
notebook-grounded response with chips and markers, and a settled ungrounded
one with neither.

**`cloudflare-worker/tests/dom-signal-contract.test.mjs`**

Runs `checkDomSignals()` and asserts `ok === true`. It is a meta-test: it
exists so that adding a selector without a capture fails CI, and it is
written so that deleting the evidence also fails.

**`cloudflare-worker/tests/agy-run-isolation.test.mjs`**

Reads `~/.local/bin/agy-run` as source — the technique
`build-stamp.test.mjs` already uses for `scripts/build-extension.py` — and
pins the three properties added after the 2026-09-29 breach:

1. the repo is snapshotted with `git status --porcelain` **before** the agent
   runs, not only compared afterwards
2. a post-run difference exits **71**, distinct from the agent's own exit code
   and from the circuit breaker's 75, so a breach cannot be read as success
3. `git status --porcelain` is used rather than `git diff`, because `diff`
   alone misses untracked files — which is how the new test file the agent
   created would have escaped notice

The path is absolute because the script lives outside the repo. The test skips
loudly with a reason if the file is absent, rather than passing silently.

### Modified

**`extension-cloudflare/native-recovery.js`**

- `generatingSignal` (line 277) — the `aria-busy` check gains a comment
  pointing at its fixture and capture date, so a reader can verify the claim
  without leaving the file. The behaviour does not change; KAN-198 is correct
  and this plan does not touch it.
- No selector is added or removed. The four dead checks (spinner, stop button,
  two lottie forms) are **kept**: they cost nothing and may match on another
  Gemini build. Their contract entries record that they were *not observed* on
  this build, which is a different statement from "wrong".

**`extension-cloudflare/notebook-attach.js`**

- `readGroundingEvidence` (line 488) — a comment recording the capture that
  justifies `source-inline-chip` and the `[cite: N]` regex, and the date. No
  behaviour change.

**`docs/HANDOFF-NEXT-SESSION.md`**

Corrected against the tree, because it currently misstates all three facts a
reader would check first:

| field | says | is |
|---|---|---|
| HEAD | `cd205ea` | `561a126` |
| tests | 459 passing | 483 passing |
| extension | `v4.7.11` | `v4.7.14`, worker still `4.7.11` |

- §9 gains KAN-196, 197, 198 alongside 190–195.
- §10.1's blocker is re-scoped: the C/D capture it describes has not been run,
  and it cannot be run until the 4.7.14 bridge is verified live, which is the
## Functions

### New: `checkDomSignals(options = {})`

`cloudflare-worker/tests/helpers/dom-signal.mjs`. Returns a `DomSignalReport`.
Checks, in order of cost:

1. every entry in `DOM_SIGNALS` has a non-empty `measured` block with a `date`
   and a `fixture` → otherwise `unmeasured`
2. every named fixture file exists and parses → otherwise `unbacked`
3. for each signal, `buildStubFromFixture(fixture, state)` is asked the
   signal's selector for each declared state, and the boolean must equal
   `states[state]` → otherwise `mismatched`

`options.signals` narrows the run to a subset, so a test can pin one signal
without re-validating the corpus. `options.repo` defaults to the repo root
resolved from `import.meta.url`, so the helper works from any test file.

### New: `buildStubFromFixture(fixture, state)`

Same file. Returns a document stub exposing `querySelector`,
`querySelectorAll` and `closest`, wired to the nodes recorded for `state` in
the fixture. It understands the selector forms the extension actually uses
and nothing else; an unrecognised selector is a development error and is
reported as such rather than resolving to `null`, because a matcher that
quietly returns `null` is indistinguishable from a matcher that is wrong.

### New: `recordCapture(fixturePath, signalId, {generating, settled})`

Same file, used by whoever takes the next capture. Exists so the capture
format has one writer and the corpus cannot drift into six shapes. It is not
called by any test — it is the tool that makes step 3 of the implementation
order a mechanical step rather than a documentation exercise.

### Modified: `generatingSignal(doc)`

`extension-cloudflare/native-recovery.js:277`. **No behaviour change.** The
`aria-busy` check at line 330 gains a three-line comment naming the fixture,
the capture date and the two observed states. KAN-198's implementation is
correct and this plan does not second-guess it.

### Modified: `readGroundingEvidence(opts = {})`

`extension-cloudflare/notebook-attach.js:488`. **No behaviour change.** Gains a
comment naming the fixture and date for `SELECTORS.sourceChip`
(`source-inline-chip`) and for the `\[cite:\s*\d+\]` marker regex, both of
which are currently asserted by `grounding-settle.test.mjs` against stubs
rather than captures.

### Unchanged, verified not to need edits

- `handleVerifyGrounding` (`content.js`) — reads grounding through
  `Attach.readGroundingEvidence`; the contract covers the evidence it consumes,
  not the settle loop that KAN-197 already fixed and mutation-checked.
- `handleCollectAnswer` (`content.js`) — consumes `isGenerating`, which the
  contract now backs.
- `buildStubFromFixture` consumers: `native-recovery-generating.test.mjs` keeps
  its current hand-written fixtures for the scoping and robustness cases, and
  gains fixture-built cases for the two measured states. Both are kept — the
  hand-written stubs prove the function survives minimal DOM shapes, which a
  real capture does not test.

### Classes

None. The codebase is procedural: the worker exposes a Durable Object class
## Dependencies

None added. No package changes, no version bumps of existing packages. The
helpers use `node:fs`, `node:path` and `node:url` — all already used by
`build-stamp.test.mjs`, which is the direct precedent for reading a script as
source and asserting on its decisions.

No new integration requirement. Everything in this plan runs under
`npm test` with no browser.


  next step after this plan.
- §10.2's "reconcile ARCHITECTURE.md" row stays open and is re-stated with the
  specific claim to correct — the `r_…` token and the "~40 dynamic inner
  fields" figure, both contradicted by the two captured samples.
- A new subsection records the 4.7.13 incident: what shipped, why the tests
  passed, and the rule that now prevents it. This is the artefact that makes
  the next session's first instinct correct.

**`CHANGELOG.md`** — one `4.7.15` entry describing the contract and the
fixture corpus, and a `Fixed` line for the stale handoff header.

### Not touched

- `cloudflare-worker/src/index.js` — no worker logic changes in this plan.
  `executeThroughExtension`, the `requireGrounding` routing and the grounding
  verdict are correct and are exercised by live runs, not by this contract.
- `extension-cloudflare/injected.js`, `model-adapter.js`, `evidence-registry.js`
  — no DOM signals of the kind covered here; `injected.js` reads `WIZ_global_data`
  and request bodies, both already covered by their own tests.
- `scripts/build-extension.py` — the staleness stamp is KAN-192's answer to
  the same class of problem and works. This plan adds the missing sibling for
  DOM signals, not a replacement.
- CI workflows, `.githooks/`, `.gitignore`.


```

Both states are stored, and they are near-identical on purpose: the settled
state still carries `has-thoughts` and `processing-state-visible`. That
similarity is the finding, and a reader can see it without opening a browser.

**`DomSignalReport` — the return of the contract self-check**

```js
{ ok: boolean, unmeasured: string[], unbacked: string[], mismatched: string[] }
```

`unmeasured` — declared with no `measured` block.
`unbacked` — names a fixture file that does not exist or does not parse.
`mismatched` — the fixture does not produce the declared `states`.

Three failure classes rather than one boolean, so the message says which
mistake was made.


tokens: attribute names, class names, tag names and one numeric height per
state, which is all any of these decisions rest on. That keeps them inside
GUARDRAILS G1.2.1, which forbids persisting prompt text, and it means a
reviewer can check a fixture by reading it.

Each signal's declaration records the date and the conditions of its capture,
so a reader can tell a fresh measurement from a two-day-old one — the same
reason the per-account skills carry a `Measured:` line, added earlier in this
session for the same reason.

## Testing

**The meta-test** — `cloudflare-worker/tests/dom-signal-contract.test.mjs`
asserts `checkDomSignals().ok === true`. It exists so that a future selector
without a capture fails CI.

That single assertion is not enough on its own, because a test asserting "the
contract is satisfied" is itself unfalsifiable if the contract can be edited to
match reality. So it is mutation-checked like everything else here:

- delete the `measured` block from any declaration → the test must fail with
  `unmeasured`
- point a declaration at a fixture that does not exist → must fail with
  `unbacked`
- flip a `states` value so the fixture no longer agrees → must fail with
  `mismatched`
- delete the whole contract check and leave the test calling it → must fail,
  proving the test is not vacuous

The last one is the one that catches a contract that has quietly become
decorative.

**Per-signal cases** — added to `native-recovery-generating.test.mjs`, keeping
its existing ten:

- the generating fixture state reads as active with
  `source === "response_aria_busy"`
- the settled fixture state reads as inactive
- the settled fixture — which still carries `has-thoughts` and
  `processing-state-visible` — is the regression case, and it is the reason the
  4.7.13 defect is caught

**Grounding chips** — a new case in `grounding-settle.test.mjs` driven from
`grounding-chips.json`: a fixture with chips and markers reports `verified`,
one without reports `no_citations_in_response`. The second is the one that
matters — a grounding check that cannot say "finished, genuinely ungrounded"
is the defect KAN-182 warned about.

**Tooling gate** — `agy-run-isolation.test.mjs` reads the script as text and
asserts the three properties listed in Files. It is a source-reading test
because the script is a shell program outside the repo; it cannot execute it
without a real agent, and pretending otherwise would be the same class of
mistake this plan exists to prevent. What it does check is real: that the
snapshot is taken before the run, that the breach exit code is distinct, and
that untracked files are included.

**Regression** — full suite `cd cloudflare-worker && npm test`, currently 483
pass / 0 fail / 5 skipped. Expected: 483 + the new cases, 0 new failures.
`version-consistency.test.mjs` must pass after the bump.

**Stated plainly** — none of this verifies that Gemini behaves correctly. It
verifies that the claims the extension makes about Gemini's DOM are backed by
observations. Whether a notebook-grounded answer is actually grounded remains
a live property, proven only by running `horo_consult` and reading the health
report, and the plan does not present a green suite as evidence about it.

## Implementation Order

1. **Helper.** Write `dom-signal.mjs` with `DOM_SIGNALS`, `checkDomSignals`,
   `buildStubFromFixture` and `recordCapture`. Declare the six signals already
   in the tree: `response.generating` (measured), and the spinner, stop-button
   and two lottie forms (declared, explicitly unobserved on this build).

2. **First fixture.** Transcribe the KAN-198 capture into
   `fixtures/generating-signal.json`. Both states, structural attributes only.
   Check it against `aria-busy` by hand before wiring it to anything.

3. **Ground the second fixture.** With the browser: open a fresh Gemini
   conversation, attach the Horo notebook, send a question, and capture
   `readGroundingEvidence`'s inputs — `source-inline-chip` presence and any
   `[cite: N]` markers — once the answer has settled. Then repeat in a
   conversation with no notebook attached. Record both as
   `fixtures/grounding-chips.json`.
   **This is the one step that needs the operator**, because
   `chrome://extensions` is unreachable from here and typing into a hidden tab
   is unreliable. Stop and wait rather than guessing the selector.

4. **Meta-test.** Write `dom-signal-contract.test.mjs` and run the four
   mutations listed in Testing. Each must be observed to fail, then reverted.
   A mutation that does not change the result means the contract check is
   decorative and must be rewritten before proceeding.

5. **Pin the shipped signal.** Add the two fixture-built cases to
   `native-recovery-generating.test.mjs`, keeping the existing ten. Confirm
   the 4.7.13 defect — keying on the permanent classes — still fails the
   regression case, since that is the exact defect the corpus exists to catch.

6. **Pin the grounding signal.** Add the fixture-driven case to
   `grounding-settle.test.mjs`.

7. **Annotate the source.** Add the fixture-and-date comments to
   `generatingSignal` and `readGroundingEvidence`. No behaviour change; verify
   with `node --check` and a zero-line diff on the executable code.

8. **Tooling gate.** Write `agy-run-isolation.test.mjs`. If `~/.local/bin/agy-run`
   is absent, the test skips with a printed reason rather than passing.

9. **Fix the handoff.** Correct the header table, add §9 entries for
   KAN-196/197/198, re-scope §10.1, re-state the `ARCHITECTURE.md` row with
   the specific false claims, and add the 4.7.13 incident record.

10. **Bump.** 4.7.14 → 4.7.15 across the five source locations, add the
    `CHANGELOG.md` entry, run `version-consistency.test.mjs`, rebuild, and
    confirm `build-extension.py --verify` reports current.

11. **Final verification.** Full suite with the measured count, `node --check`
    on every changed file, `--verify` on the build, `git status` clean. State
    the measured numbers rather than the expected ones.

Steps 3 is the only one that needs the operator, and the plan halts there
rather than assuming a capture. Everything else runs under `npm test` with no
browser, which is the point: the next selector someone adds will be checked
against a capture by default, not by intention.

(`GeminiBridgeDO`), the extension uses IIFEs with a registry `Map`
(`model-adapter.js:17`). The contract is a plain frozen array of objects.
