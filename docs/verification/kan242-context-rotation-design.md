# KAN-242 — Automatic Conversation Context Rotation (Design)

**Status:** design only, no code changed. **Baseline:** v4.7.34. **Date:** 2026-10-04.
**Trigger:** live telemetry run — calls 1–2 ok (~48–50 s), call 3 failed after 160,269 ms with
`no_answer_rendered, responses on screen = 10`. Hand-off rule: never let one Gemini `/app` conversation
accumulate more than ~8–9 `model-response` elements.

## 1. Where the relevant state lives today (code map)

| Concern | Location | Notes |
|---|---|---|
| "responses on screen" (DOM truth) | `extension-cloudflare/native-recovery.js` `countModelResponses()` (L98) and duplicate in `prompt-typing.js` (L111) | `document.querySelectorAll("model-response").length` |
| Count before send | `prompt-typing.js` L463 → `TYPE_PROMPT_RESULT.responsesBefore` (content.js L1716-1726) | Accurate, but only known *after* the prompt was sent |
| Heartbeat | `content.js` `handleCollectAnswer` L1831-1851: `COLLECT_ANSWER_PROGRESS {generating, responses}` every 3 s; final `COLLECT_ANSWER_RESULT {responses}` (L1913) | Relayed by `background.js` L1177 allow-list |
| Worker-side copy of count | `index.js` `this.lastCollectedResponseCount` — written at L2347 (PROGRESS) and L2370 (RESULT); surfaced as `/health` → `collection.last_progress_responses` (L4459) | **In-memory only**; `0` after DO eviction/restart; never set before the first collection |
| Failure text | `index.js` L1928-1934 (`responses on screen=${collected.responses}`); reason `no_answer_rendered` is produced extension-side content.js L1901 | |
| Typed path entry | `executeThroughExtension` → `typePromptThroughUi` (L1899, L2205) → `collectTypedAnswer` (L1921, L2270). Forced for every MCP tool (`requireTypedPath:true`, L4076) and for `/v1/chat/completions` replay-timeout fallback | single choke point for typed turns |
| Scope state | DO: `this.currentScope` (set from `SESSION_READY`/`SCOPE_READY`, L2783-2810, and `applyScope` L3743 / `/v1/chat/completions` L3097-3117), `lastNotebookScope`, `targetNotebookScope`, `conversationState{conversationId…}` (L362, effectively unused: only exposed in `/health`) | `currentScope` can be **stale `"app"`** while the tab URL is already `/app/<id>` |
| Scope switch mechanics | `prepareScope(scope)` (L1686) → wire `PREPARE_SCOPE` → `background.js handlePrepareScope` (L986): if leader tab's `scopeFromPath(url) !== target` it does `tabs.update(leader,{url: scopeToUrl(target)})`; bare `app` → `https://gemini.google.com/app` = **a brand-new empty chat** → page reloads → content script re-announces `SESSION_READY` → `resolvePendingScopes` → `SCOPE_READY` | This *is* the existing "fresh /app conversation" primitive |
| Why `applyScope` is not enough | `applyScope` (L3749) and `requestScopeSwitch` (L1086) short-circuit when `currentScope === target` — so `applyScope("app")` is a no-op if currentScope is the stale `"app"` | rotation must call `prepareScope("app")` directly (forced) |
| horo_consult notebook attach | L3997-4050: `runNotebookAttach` (`ATTACH_NOTEBOOK`) **every call, before** `executeThroughExtension`; chip is consumed per message; then `verifyNotebookGrounding` (L4128) | attach is a UI chip on the *current* page → rotation must happen **before** the attach, never between attach and send |
| Serialization | Only `/v1/chat/completions` is queued (`fetch()` L2507, `requestBusy`/`pendingRequests`). MCP `tools/call` is **not** queued | rotation needs its own guard (see §4) |
| Telemetry | `recordTelemetry` (L1721), `/debug/telemetry`, ring of 50 | add `kind:"rotation"` |

Key observation from the run: calls 1 and 2 only added 2 responses, yet the page showed 10 at call 3 → the
conversation **already held ~7–8 responses before the measurement started**. A DO-side turn counter
(`+1 per call`) would have missed this. The counter must come from the **DOM**, not from bridge call counts.

## 2. Design summary

1. **Probe** (extension): new request `CONVERSATION_STATS` → content script replies `CONVERSATION_STATS_RESULT {responses, userQueries, scope, pathname, generating}` (pure DOM read, no side effects).
2. **Decision** (worker, DO): helper `ensureConversationHeadroom({ requestId, reason })` runs *before* the typed turn. If `responses >= CONTEXT_ROTATION_THRESHOLD` (default 8) and not generating → rotate.
3. **Rotate** (worker→extension, existing machinery): `await this.prepareScope("app")` (forced, bypassing the `currentScope===target` shortcut), then `this.currentScope = ready.scope`, reset `lastCollectedResponseCount = 0`, record telemetry, bump `rotation` counters.
4. **Then** proceed with the unchanged flow (horo: attach → typed send → collect → verify grounding).
5. Feature flag: `env.CONTEXT_ROTATION_THRESHOLD` (string int). **Unset/`0` = disabled in code**; set to `8` in `wrangler.toml [vars]` for prod. This keeps every existing test (whose mock socket is `{readyState:1, send(){}}`, silent) untouched and avoids a probe timeout in them.

### 2.1 Where to count
- **Authoritative:** probe in the content script (`Recovery.countModelResponses(document)`; same function the failure path uses, so threshold and failure messages agree).
- **Fallback when probe unavailable** (old extension, 2 s probe timeout, or `CONVERSATION_STATS` unanswered): use `this.lastCollectedResponseCount` if `> 0`; if that is also unknown, fail **open** (no rotation) and log `vlog`.
- **Piggyback (cheap, zero new messages):** `TYPE_PROMPT_RESULT.responsesBefore` + 1 and `COLLECT_ANSWER_RESULT.responses` already refresh `lastCollectedResponseCount` after every typed turn, so the fallback is accurate in steady state; the probe covers cold DO / manual user activity in the tab.
- Count `model-response`, not user queries (matches the observed failure signature). Optionally also record `userQueries` for the data matrix.

### 2.2 Where to trigger
Single new method `async ensureConversationHeadroom(ctx)` on `GeminiBridgeDO`, called from exactly these sites:

| Call site | Position | Why |
|---|---|---|
| `tools/call` horo_consult branch (~L3997) | **before** `runNotebookAttach`, inside `runInPreparedScope` after `isExtensionReady()` | attach chip would be destroyed by a navigation done after it; this also satisfies "re-attach notebook per message" for free because the normal attach follows the rotation |
| `tools/call` other typed MCP tools (sdlc_*, code_review…) | before `executeThroughExtension` (L4072) | same typed path, same 10-response frontier |
| `/v1/chat/completions` | right after the scope block (L3117), **before `prepareModel`** (L3129) | navigation republishes the catalog / may reset model; `prepareModel` must run after it |
| NOT inside `executeThroughExtension` | — | it would run after horo's attach (chip loss) and runs for replay turns that never touch the DOM |

Skip rotation when: `requireGrounding`-less replay-only turns (chat completions replay path doesn't render in DOM — probe still harmless, but only rotate when the request will actually use typed path; for chat completions that is unknown until the replay times out, so **rotate on chat completions only if `count >= threshold` regardless** — cheap and safe), or when `effectiveScope`/`scope` argument pins an `app:<id>` conversation (see §3).

### 2.3 Scope handling matrix

| `currentScope` / request scope | Action |
|---|---|
| `null`, `"app"`, `"app:<id>"` implicit (no explicit scope arg) | `prepareScope("app")` → fresh `/app`; set `currentScope="app"` |
| horo_consult default (`wantsDefaultNotebook`, scope arg empty) | same as above (attach happens afterwards on `/app`). `targetNotebookScope` unchanged |
| Explicit `scope:"app:<id>"` (caller deliberately pins a conversation) | **Do not rotate**; log warn + telemetry `skipped:"pinned_scope"`. Open question Q2 |
| Explicit `scope:"notebook:<id>"` / `/notebook/<id>` page | Re-navigate same scope via `prepareScope(sameScope)` is *not* possible through the shortcut-free path unless tab URL differs; notebook page submit spawns `/app/<new>` anyway (L2056-2064). Treat as "pinned": skip + warn. Q3 |
| `restorePreCallScope` (L3896) | Unchanged. Because rotation sets `currentScope="app"` *before* `scopeBeforeCall` is captured? **No** — `scopeBeforeCall` is captured at L3887, earlier. Rotation must therefore update `scopeBeforeCall`-equivalent only if it changed the scope *kind*; since we only ever rotate `app*`→`app`, and horo default does not switch scope (`effectiveScope=null`, `switchedScope=false`), restore stays a no-op. Test required (§6). |

## 3. Implementation plan (files / functions)

**Extension (`extension-cloudflare/`)**
1. `protocol-messages.js` `MessageTypes`: add `CONVERSATION_STATS` (worker→ext) and `CONVERSATION_STATS_RESULT` (ext→worker). Update `payload-shape-contract` / message-type enumerations.
2. `content.js` `handleWorkerMessage` switch (~L669): `case "CONVERSATION_STATS": handleConversationStats(msg)` — leader-tab only, mirrors `handleCollectAnswer` style; reply with `Recovery.countModelResponses(document)`, `countUserQueries`, `Recovery.isGenerating(document)`, `detectScope()`, `location.pathname`.
3. `background.js`: add `"CONVERSATION_STATS"` to the downward forward case list (L930-940) and `"CONVERSATION_STATS_RESULT"` to the upward allow-list (L1177). *(Both lists were the cause of a past silent-drop bug — see PAYLOAD_CAPTURE_ARM comment.)*
4. Bump `manifest.json` version (extension must be reloaded by the operator; worker must tolerate old extension = probe timeout).

**Worker (`cloudflare-worker/src/index.js`)**
1. Constructor: `this.rotationState = { total:0, lastAt:null, lastBefore:null, lastReason:null, lastError:null, inFlight:false }`; `this.typedTurnsInFlight = 0`.
2. `requestConversationStats({requestId, timeoutMs=2000})` — clone of `verifyNotebookGrounding` pattern (activeStreams handler + timer, resolves `{ok:false}` never throws).
3. `rotationThreshold()` → `parseInt(env.CONTEXT_ROTATION_THRESHOLD)`; `<=0`/NaN ⇒ disabled.
4. `ensureConversationHeadroom({requestId, explicitScope})`:
   - disabled / pinned scope / `this.rotationState.inFlight` / `this.typedTurnsInFlight>0` → return `{rotated:false, reason}`.
   - get count (§2.1); `< threshold` → `{rotated:false}`.
   - `rotationState.inFlight=true`; `t0=Date.now()`; `await this.prepareScope("app")` in try/catch; on success `currentScope = ready.scope || "app"`, `lastCollectedResponseCount = 0`, `addScopeFailClosed` check not needed for bare app (but keep: if it returns an error, treat as rotation failure).
   - `recordTelemetry({kind:"rotation", outcome, durationMs, responsesBefore, threshold})` (metadata only; extend the `BaseTelemetryEntry` doc in the measurement plan).
   - **Failure policy:** fail-open — if rotation fails, log + record `recordHealthError("rotation_failed:…")` but still attempt the call (status quo behaviour) *except* for horo_consult where grounding is already fail-closed downstream. Never throw from this helper.
   - finally `inFlight=false`.
5. Wire into the three call sites of §2.2; wrap typed turns with `typedTurnsInFlight++/--` in `executeThroughExtension`'s typed branch so a concurrent MCP call cannot navigate the tab under a generating turn.
6. `/health`: add `conversation_rotation: {enabled, threshold, total, last_at, last_responses_before, last_outcome}`; `check_bridge_health` MCP output may optionally mention it.
7. `wrangler.toml [vars]`: `CONTEXT_ROTATION_THRESHOLD = "8"`.
8. Update `docs/verification/kan242-latency-measurement-plan.md` §2.2 with the `rotation` telemetry variant, and HANDOFF.md T3 status.

**Optional phase 2 (not in first PR):** one-shot recovery — on `collect_answer_timeout`/`no_answer_rendered` with `responses >= threshold-1`, rotate then retry the prompt once. Risky (prompt may have actually been submitted, 160 s already burned); only for idempotent read-only tools; needs explicit decision (Q4).

## 4. Failure modes & mitigations

| # | Failure mode | Mitigation |
|---|---|---|
| F1 | DO restarted → `lastCollectedResponseCount=0`, rotation never fires | Probe is primary source |
| F2 | Old extension ignores `CONVERSATION_STATS` | 2 s timeout → fallback to counter → fail-open; health shows `last_outcome:"probe_unavailable"` |
| F3 | Another typed turn is generating (MCP calls aren't queued) → rotation navigates mid-answer | `typedTurnsInFlight` + `isGenerating` guard → skip rotation (log) |
| F4 | Navigation fails / 45 s timeout (`scope_switch_failed`, no leader tab) | fail-open, record error, one retry at most; do not loop |
| F5 | Stale `currentScope==="app"` makes `applyScope` a no-op | call `prepareScope` directly, never `applyScope`/`requestScopeSwitch` |
| F6 | Chip lost because rotation happened after attach | ordering rule §2.2 (rotate before attach); test asserts order |
| F7 | New page resets model (Flash-Lite→default) or thinking toggle | chat completions: rotate before `prepareModel`; MCP path: **verify live** that `activeBrowserModel` is unchanged post-rotation (Q1); if not, call `prepareModel(targetModel)` after rotation |
| F8 | Tab reload drops WS leader / content script not ready → `typePromptThroughUi` fails `input_not_found` | `prepareScope` already waits for `SESSION_READY`; add `waitForExtension()` + short settle (`typePromptThroughUi` has its own composer waits) |
| F9 | Rotation loop (count stays ≥ threshold because probe reads a not-yet-cleared DOM) | after success require probe `responses==0` once (best effort, 1×) else just proceed; never rotate twice within one request |
| F10 | User is using the same Gemini tab manually; rotation discards their chat | document: bridge tab is dedicated; skip rotation when `userQueries>0 && lastBridgeActivityAt` is older than N min (Q5) |
| F11 | Latency cost: rotation ≈ page load + SESSION_READY (est. 3–8 s) once per ~8 turns | acceptable vs 160 s timeouts; recorded in telemetry |
| F12 | Grounding: new conversation might change `verifyNotebookGrounding` behaviour | actually improves it (error text at L4165 already advises "start a fresh conversation") |

## 5. Interaction with existing behaviours
- **horo_consult re-attach per message:** unchanged; rotation is strictly *before* `runNotebookAttach`; the attach always runs on whichever conversation is current (old or new).
- **Session Isolation Rule:** complementary; rotation is the automatic enforcement inside a single orchestrator session.
- **`conversationState`:** currently dead state; rotation may reset it (`conversationId=null`) for `/health` honesty.
- **Idle-based `collectTypedAnswer` deadline (KAN-236):** untouched; rotation reduces the chance of hitting it.

## 6. Test plan

New files (node:test, `cloudflare-worker/tests/`, following `collect-typed-answer-worker-deadline.test.mjs` / `horo-grounding-failclosed.test.mjs` harness style: fake `activeSocket`, `h.deliver(msg)`):

1. `context-rotation-threshold.test.mjs`
   - `rotation disabled when CONTEXT_ROTATION_THRESHOLD unset/0/NaN` (no send of CONVERSATION_STATS / PREPARE_SCOPE)
   - `no rotation below threshold (7)`; `rotates at 8`; `rotates at 10 (observed failure frontier)`
   - `uses probe count over stale lastCollectedResponseCount` (DO restart scenario: counter 0, probe 9 ⇒ rotate)
   - `falls back to lastCollectedResponseCount when probe times out`; `fails open when both unknown`
   - `does not rotate while generating / typedTurnsInFlight>0`
2. `context-rotation-scope.test.mjs`
   - `rotation calls prepareScope("app") even when currentScope is stale "app"` (guards F5)
   - `sets currentScope from SCOPE_READY and resets lastCollectedResponseCount`
   - `skips rotation for explicit app:<id> / notebook:<id> scope` (pinned)
   - `restorePreCallScope remains a no-op after rotation`
   - `rotation failure (scope_switch_failed) is fail-open and recorded in telemetry/health`
3. `context-rotation-horo.test.mjs`
   - `horo_consult rotates BEFORE ATTACH_NOTEBOOK` (assert wire order: CONVERSATION_STATS → PREPARE_SCOPE → ATTACH_NOTEBOOK → TYPE_PROMPT → COLLECT_ANSWER → VERIFY_GROUNDING)
   - `horo_consult still attaches once per call after rotation`
   - `no rotation between attach and type`
   - `chat completions rotates before PREPARE_MODEL`
4. `context-rotation-telemetry-health.test.mjs`
   - `rotation entry recorded {kind:"rotation", outcome, durationMs, responsesBefore}` and contains no prompt text
   - `/health exposes conversation_rotation block`
5. `extension-conversation-stats.test.mjs` (pattern of `extension-injected.test.mjs`/`dom-signal-contract.test.mjs` with `helpers/dom-signal.mjs`)
   - `CONVERSATION_STATS counts model-response elements and reports scope`
   - `background relays CONVERSATION_STATS down and CONVERSATION_STATS_RESULT up` (allow-list regression, cf. PAYLOAD_CAPTURE_ARM)
   - `MessageTypes contains the new types` (in `multiplexed-protocol`/`payload-shape-contract` style)

Existing tests likely affected (re-run, small edits at most):
- `horo-grounding-failclosed.test.mjs`, `sdlc-tool-args.test.mjs`, `mcp-protocol.test.mjs`, `gemini-refusal-retry.test.mjs`, `health-counter-reset.test.mjs`, `red-team-adversarial.test.mjs` — exercise tools/call + `executeThroughExtension` with silent sockets; safe because feature is **off by default**; add one assertion that no extra wire messages are sent when disabled.
- `scope-switch-roundtrip.test.mjs`, `scope-switching.test.mjs`, `scope-router.test.mjs` — verify `prepareScope`/`currentScope` semantics unchanged.
- `collect-typed-answer-deadline.test.mjs`, `collect-typed-answer-worker-deadline.test.mjs` — `lastCollectedResponseCount` semantics must stay.
- `health-metrics.test.mjs`, `kan182-telemetry-endpoint.test.mjs` — if they deep-equal `/health` or telemetry shape, update.
- `version-consistency.test.mjs`, `build-stamp.test.mjs`, `extension-version-line.test.mjs` — if the extension version is bumped (manifest + worker + package.json must move together).
- `payload-shape-contract.test.mjs` / `extension-rpc-v2.test.mjs` / `multiplexed-protocol.test.mjs` — if they enumerate message types.

Live verification (after deploy + extension reload): loop the KAN-242 probe from a conversation pre-loaded to ≥9 responses; expect `rotation` telemetry entry, then `executeThroughExtension` ok at ~48–50 s, and `/health.collection.last_progress_responses` small (1–2) afterwards.

## 7. Effort estimate

| Chunk | Estimate |
|---|---|
| Extension: message types, content handler, background relay lists, manifest bump | 0.5 day |
| Worker: probe, `ensureConversationHeadroom`, wiring at 3 sites, in-flight guard, health/telemetry, vars | 1 day |
| Tests (5 new files + adjustments) | 1 day |
| Live verification incl. model-reset check (Q1) and operator extension reload | 0.5 day (needs human reload of extension + foreground Chrome) |
| **Total** | **~3 engineering days** (≈2 days if the optional probe is dropped and only the counter fallback is used — not recommended because of F1) |

Minimum-viable variant (≈1 day): worker-only, rotation based on `lastCollectedResponseCount` (+ `responsesBefore`) with `prepareScope("app")`; no new extension messages. Weakness: blind after DO restart and for the pre-loaded conversation seen in the KAN-242 run.

## 8. Open questions
- **Q1** Does a fresh `/app` keep the previously selected browser model / thinking toggle? (Decides whether `prepareModel` must be re-run after rotation on the MCP path.)
- **Q2** Should an explicit `scope:"app:<id>"` argument ever be rotated away from? Proposed: no (caller pinned it).
- **Q3** How should notebook-scope (`/notebook/<id>`) sessions be rotated? Proposed: not at all (that page already spawns a new `/app` conversation on submit).
- **Q4** Is the optional "rotate-and-retry once on timeout" wanted, given duplicate-submit and 160 s cost?
- **Q5** Is the Gemini bridge tab dedicated (safe to discard its chat), or may a human use it?
- **Q6** Threshold: 8 (hand-off) vs 7 for margin — each horo_consult adds exactly 1 response, but retries/native-retry add extra `model-response` elements; also confirm whether `model-response` counts draft/regenerated variants.
- **Q7** Should MCP `tools/call` get queued like `/v1/chat/completions` (`requestBusy`)? Currently concurrent MCP calls can already race the single tab; rotation makes the race more damaging (guard F3 only mitigates).
- **Q8** Env-var default: enable in `wrangler.toml` immediately, or ship disabled and flip after live verification?
