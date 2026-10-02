# Notebook API feasibility — KAN-236 direct path

**Verdict: NOT ESTABLISHED. The direct worker → `StreamGenerate` path remains
unbuilt and unproven. This document records why, and what it would take.**

> **Update 2026-10-02 (later the same day).** Blocker 2 is gone and blocker 1 is
> now a single Reload button. The capture path is built, deployed and
> auth-verified. See "The relay" below before re-reading the blocker text, which
> is retained because it explains why the relay was built this way.

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

## The relay (4.7.28 / 4.7.29)

The sanitized record already existed. `injected.js` runs a fetch/XHR interceptor
on every request and, for `StreamGenerate`, already builds a record reduced by
`extractBoundedStructure` — `{kind, length, cls}` per node, no prompt text, no
token — and then discarded it unless a page-console toggle was on. It was being
computed in production and thrown away.

4.7.28 ships it to the worker instead, so the captures are readable with curl.

**Where it lives.** The obvious home was `/health`, and that is the wrong one:
measured, an unauthenticated `GET /health` returns **200**. It is public. Field
counts, string lengths and whether a notebook ref is present are conversation
metadata and do not belong on a world-readable endpoint. It is therefore
`/debug/payload-capture`, which is not in `publicPaths` and so falls under the
generic bearer gate — verified returning **401** unauthenticated. A test asserts
`publicPaths` never gains it, because the convenient-looking change is exactly
the one that would leak it.

**The safety properties, and one that was not actually tested.** Off on load;
dropped at the worker if unarmed; buffer capped at 3; never logged; cleared on
arming so cases cannot bleed. The first version of the "off by default" test
called `armPayloadCapture(false)` and then asserted the relay was quiet — which
passes even with the default flipped to `true`, because it never read the
default. Found by mutation: flipping it left all 8 tests green. Fixed by
exporting `isPayloadCaptureArmed` so the default is readable without being set.

**A bug that shipped, caught only by running it.** 4.7.28 wired the upward hop
(record → worker) but not the downward one (arm → page): `PAYLOAD_CAPTURE_ARM`
was missing from `background.js`'s `forwardToActiveTab` group. `POST` returned
`{"armed":true}`, the DO flag flipped, and zero captures arrived. Half of a
two-way relay is indistinguishable from a working one in a diff, and an endpoint
that reports success turns a broken chain into a silence rather than an error.
Fixed in 4.7.29 and pinned by a test that walks both directions; its mutation is
confirmed failing.

### What remains: one button

Reload the extension at `chrome://extensions` so `background.js` is 4.7.29. Then
arming, the three captures and the analysis are all automatable.

Note `GET /health` still reports **4.7.28** after the 4.7.29 deploy: the Durable
Object keeps running the code it was instantiated with until it is reset. The
only worker-side change in 4.7.29 was the version string itself — the functional
fix is in the extension — so the discrepancy is cosmetic, but it is real and
worth knowing before someone reads it as a failed deploy.

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

There are **two independent blockers**, either of which alone is sufficient. That
matters, because clearing one would not have produced the capture.

**Blocker 1 — the probe cannot be switched on.** Enabling `PAYLOAD_PROBE`
requires posting a message into the page. In this session that path was
unavailable: `kapture__evaluate` returned `{}` for even `() => 1+1`, and by the
time Phase D began it was no longer in the toolset at all. The alternatives are
closed for concrete, recorded reasons:

- Browser MCP is a **different Chrome instance** — its `chrome://extensions`
  lists zero extensions and searching `bridge` returns `0 results`, so the
  Gemini bridge is not installed in that profile at all.
- Kapture is attached to the **correct** Chrome but refuses browser-internal
  pages: `navigate` to `chrome://extensions/` returns `NAVIGATION_BLOCKED`.
  (`new_tab` on the same URL is worse — it does not error, it silently redirects
  to Kapture's own docs page.)

**Blocker 2 — the output could not be read.** The probe's only sink is
`console.log`, and the Kapture extension is **degraded**, not merely quiet:

| call | behaviour |
|---|---|
| `console_logs` | `totalCount: 0` after reloads and across many successful `horo_consult` calls that certainly logged. It returned **58** entries at session start. |
| `new_tab` | Ignores the URL entirely — `https://gemini.google.com/app` and `chrome://extensions/` both open Kapture's own docs page. Not URL filtering: a plain https URL is dropped too. |
| `new_tab` (continued) | The tab it opens is then dropped from the tab list within a second, and reading its console returns `Tab not found`. |
| `navigate` | Works on a real page; correctly refuses `chrome://` with `NAVIGATION_BLOCKED`. |

So the earlier reading — "new_tab redirected `chrome://extensions/` to a docs
page, therefore it filters `chrome://`" — was **wrong**. It does not filter; it
does not navigate at all. The `NAVIGATION_BLOCKED` result from `navigate` is the
honest signal, and it is the only one worth acting on.

Blocker 2 is the one worth dwelling on. Had the reader merely looked empty
without that 58-entry baseline, "the probe never fired" would have been a
reasonable reading. With the baseline it is not — and an instrument reporting
"nothing happened" when it has stopped working cannot support a conclusion in
either direction.

This is the same lesson that produced the 4.7.27 `/health` `collection` block:
the heartbeat was moved off the console onto an endpoint that cannot detach. The
payload probe cannot use that route, because its records are per-request and
arbitrarily large.

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

### 3. Why no remote probe toggle was built

A worker → extension → page relay would clear blocker 1. It was deliberately not
built, for three reasons.

- `handleProbeSet` is page-scoped **by design**. The probe writes only
  `{type, length, cls}`, and only to `console.log`, precisely because the console
  is the one sink that cannot persist anything — and it is off by default
  precisely because a shipped build should not be logging request structures at
  all. A remotely-armed switch inverts that decision.
- Even sanitized, a switch any bridge caller can trigger to make the extension
  log request structures is an information-disclosure surface. That is a worse
  trade than this measurement is worth.
- **It would not have unblocked Phase D anyway** — blocker 2 stands regardless.
  Adding a production debug backdoor to clear half a problem, and then still not
  obtaining the capture, is a bad trade twice over.

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

1. ~~Reload the extension~~ — **done**, and confirmed live via
   `/health` → `collection.last_progress_at` (see
   `cloudflare-worker/tests/fixtures/submit-diagnostics.json` →
   `extension_reload_status`). Both blockers below still need a human, so this
   is recorded as a prerequisite already met rather than a remaining step.
2. Enable the probe from that extension's devtools console, **with the page's
   own DevTools open** — Kapture's console reader is detached, so a capture read
   through it comes back empty:
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
