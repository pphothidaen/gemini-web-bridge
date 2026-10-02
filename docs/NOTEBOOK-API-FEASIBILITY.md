# Notebook API feasibility — KAN-236 direct path

**Verdict: NOT ESTABLISHED. The direct worker → `StreamGenerate` path remains
unbuilt and unproven. This document records why, and what it would take.**

This is a negative result reached without fabrication. The measurement that
would have confirmed or killed the idea could not be taken in this session, and
the one capture on file was not re-verified. Both facts are stated here rather
than papered over with an estimate.

## What the idea was

The bridge currently drives Gemini by typing into the page's own input box
(`prompt-typing.js`) and then polling the rendered `model-response`
(`collectTypedAnswer`). That path costs a full round trip through the UI, is
brittle against Google's own markup, and — per the KAN-236 work in 4.7.25 — needs
a heartbeat and a hard cap just to survive a slow generation.

The proposed replacement: skip the page. Have the worker POST directly to
`StreamGenerate` and decode the `wrb.fr` chunk stream, which
`ProtocolDecoder.decodeChunk` already does for the replay path.

## The two known blockers

### 1. The payload shape is not known, and guessing is not acceptable

`buildStreamGenerateRequest` in `cloudflare-worker/src/index.js` emits a
**10-field** array. The browser emits a **19-field** array, recorded in
`cloudflare-worker/tests/fixtures/streamgenerate-captures.json`. The divergence
is not cosmetic — index 2 is a type contradiction, not a length difference:

| index | worker builder | browser |
|---:|---|---|
| 2 | `[conversationId, responseId, choiceId, null, null, []]` | `null` |
| 3 | *(absent)* | string, 2187 chars — the context block |
| 4 | *(absent)* | string, 32 — conversationId |

Three things are unknown, and all three are load-bearing:

- **Which field carries the context block.** 2187 characters is consistent with
  the notebook system context the bridge depends on, but the field is classified
  `opaque` and its content was never captured.
- **Where the notebook reference actually goes.** No notebook id was observed
  in the one capture on file, and that capture was the *ungrounded* case.
- **Whether the two are separable.** If the context block and the reference are
  one field, a direct call cannot attach and untether the notebook the way the
  page does — which would end this line of work rather than reshape it.

### 2. The measurement could not be taken

Enabling `PAYLOAD_PROBE` requires posting a message into the page. In this
session that path was unavailable: `kapture__evaluate` returned `{}` for even
`() => 1+1`, and by the time Phase D began it was no longer in the toolset at
all. There is no other route from here into the page's JS context.

Consequence, stated plainly:

- The **chip-present** capture does not exist.
- The **chip-repeat** capture does not exist.
- The **chip-absent** capture was not retaken.

Only the 2026-10-01 ungrounded capture exists. Its provenance was not
re-confirmed, and the fixture now says so at the top of the file rather than
continuing to assert it.

The one capture on file also has a **classifier gap** recorded against it — the
notebook reference was looked for under `notebook://` and not found, while the
live scope string uses `notebooks://` — so even that capture cannot yet be used
to claim the reference is absent. It is unresolved, not negative.

## What was deliberately not done

Re-deriving the structure by hand from a captured `StreamGenerate` request body
would have produced a document faster. It was rejected: the raw body contains
the full prompt and session tokens, and GUARDRAILS G1.2.1 puts that surface out
of bounds for written artifacts. `payload-classifier.test.mjs`'s leak canary
exists to make that boundary checkable — and a hand-derived structure would pass
the canary while having been produced by exactly the means the canary is meant
to prevent. Passing a check by circumventing the thing it checks is worse than
not having the data.

No `scripts/analyze-payload-shape.mjs` was written, and
`cloudflare-worker/tests/payload-shape-contract.test.mjs` was not added. Both
were planned as consumers of captures that do not exist. Writing them now would
mean pinning a shape I cannot substantiate, which converts an open question into
a false certainty.

## To actually resolve this

1. Reload the extension at `chrome://extensions` so `content.js` is the 4.7.25
   build. This is required regardless — until then the 4.7.25 worker runs with
   no heartbeat and behaves exactly as 4.7.24 did.
2. Enable the probe from that extension's devtools console:
   `window.postMessage({source:"GEMINI_CONTENT", type:"PAYLOAD_PROBE_SET", enabled:true}, "*")`
3. Take the three cases: chip present, chip absent, chip repeat. The repeat case
   is the one that decides whether a notebook id is stable across calls, which
   is what a direct path would have to cache.
4. Close the classifier gap first — re-run the notebook-reference search under
   `notebooks://` before concluding anything from the `notebook://` result.
5. Only then build the analyzer and the contract test.

Steps 1–3 are all manual browser work. None of them are currently reachable from
this environment, which is why this document ends at a verdict rather than a
recommendation.

## Related

- Phase D of `implementation_plan.md` — blocked, same cause.
- `CHANGELOG.md` `[4.7.25]` — the caller-side timer fix that made the slow
  generation survivable in the meantime. That fix stands on its own and does not
  depend on the direct path existing.
