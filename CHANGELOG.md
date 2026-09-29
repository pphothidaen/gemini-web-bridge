# Changelog

All notable changes to the Gemini Web-Bridge project.

## [4.7.16] - 2026-09-29

### Fixed
- **The grounding check claimed two independent signals and had one.**
  `readGroundingEvidence` counts `source-inline-chip` elements and
  `[cite: N]` markers, and the comment called them independent: either was
  enough to call an answer grounded. On every grounded run recorded
  2026-09-29 the chip count was 7 or 8 and the marker count was 0 - so the
  marker branch has never been taken, and the chip selector has been
  carrying the entire decision alone. A branch that cannot fire is not a
  second opinion; it is decoration that made a weaker check look stronger.
  Both signals are now declared in the DOM signal contract with the counts
  that establish this, and a test fails if either claim is quietly upgraded.

### Added
- **A sweep that ends the open-endedness.** Fixing did not terminate because
  each fix exposed the next unverified selector, and the contract covered
  four of roughly twenty. Every load-bearing selector the extension reads is
  now either confirmed working by live console evidence or confirmed absent
  on this build, recorded in `tests/fixtures/observed-selectors.json`. A test
  walks the load-bearing list and fails on any selector with no evidence, so
  a new selector added without a measurement is caught here rather than in
  production.

  The fixture is counts and step results, not a DOM capture, and says so
  plainly. Presenting it as a capture would repeat the mistake it fixes.
  A true DOM capture of the attach flow and prompt box remains open as the
  one measurement that cannot be transcribed.

### Notes
- Not deployed. The worker still runs 4.7.11; `wrangler deploy` is left to the
  operator.

## [4.7.15] - 2026-09-29

### Added
- **A DOM signal must be backed by a capture.** Every selector the extension
  reads out of Gemini's page is now declared in
  `cloudflare-worker/tests/helpers/dom-signal.mjs` with its expected value in
  each state and the observation that justifies it. `checkDomSignals()` fails
  the build when a signal has no recorded capture, names a fixture that does
  not exist, or claims something its capture contradicts. Captures live in
  `cloudflare-worker/tests/fixtures/` as structural attributes only — no text,
  no tokens, nothing GUARDRAILS G1.2.1 forbids persisting.

  This is the enforced form of a rule that was learned twice the hard way. In
  KAN-192 a test asserted a manifest string while the JavaScript beside it was
  older. In KAN-197/198 a test asserted that `has-thoughts` meant "currently
  processing" — it means "has a thinking section", permanently — and shipped a
  bridge that could not answer at all. Both were correct as data and wrong as
  evidence, and nothing in the repo required the evidence to exist.
- **A regression test for the delegation tooling's isolation gate.**
  `agy-run --mode worktree` claimed the caller's repo was untouched; on
  2026-09-29 that claim was false, because a packet with a hardcoded
  `cd /Users/…/repo` sent an isolated delegate out of its worktree and the run
  still reported success. The gate now snapshots the repo with
  `git status --porcelain` before the agent starts, exits 71 on a breach, and
  includes untracked files. The test pins all three.

### Fixed
- **The handoff document misstated the tree.** Its header named `cd205ea` and
  459 tests where the truth was `561a126` and 492, and described the extension
  as 4.7.11 while the worker was still the deployed version. A document that
  lies about the tree is the same defect one level up.

### Notes
- Not deployed. The worker still runs 4.7.11; `wrangler deploy` is left to the
  operator. This change is extension-side and test-side only.

## [4.7.14] - 2026-09-29

### Fixed
- **The generating signal read two class names that never change.**
  4.7.13 keyed `isGenerating()` on `processing-state-visible` and
  `has-thoughts`, sampled once from a response that was still streaming. They
  are permanent: the same response measured after settling still carried
  `class="model-response-text has-thoughts processing-state-visible"`, beside
  a `response-footer … has-thoughts complete`. So the signal stayed true after
  the answer was done, `handleCollectAnswer` burned its full 120s budget, and
  every call failed with `collect_answer_timeout` on an answer that had been
  finished for a minute.

  The signal is `aria-busy`, measured by sampling the DOM across one whole
  generation: present at 1242px and again at 3508px, absent once settled.
  It is the only candidate that differs between the two observed states.

### Notes
- The tests for this were written from the assumption rather than from a
  capture, which is why they passed against code that wedged production. The
  fixtures are now the measured before/after DOM, and re-introducing the
  4.7.13 check fails four of them.
- Not deployed. The worker still runs 4.7.11; `wrangler deploy` is left to the
  operator.

## [4.7.13] - 2026-09-29

### Fixed
- **The bridge judged a half-written answer.** `generatingSignal()` checked a
  spinner, a stop button and a lottie clipPath. None of them exist on this
  build: the response instead carries
  `processing-state-visible` and `has-thoughts`, and neither was looked for. So
  `isGenerating()` returned false mid-generation, `handleCollectAnswer` stopped
  waiting, and the worker ran its grounding check on a partial answer.
  Measured: `COLLECT_ANSWER` reported `chars=37` and the answer was judged
  `no_citations_in_response`, while the same response was 1267px tall and
  complete moments later. The class check is scoped to the newest response,
  because a finished response keeps `has-thoughts` permanently.
- **Grounding settled after 1.2 seconds of stillness.** A gap between two
  bursts of a long Thai answer looked identical to a finished one, and
  citations stream in after the text. The settle window is now 4 seconds, the
  counter is suspended while the response is still generating, and a timeout
  that expires mid-generation reports `timeout_while_generating` rather than
  claiming citations were absent.

Both were the same defect at two layers, and the second is the one KAN-182
already warned about: an unreadable answer reported as an ungrounded one.

### Notes
- Not deployed. The worker still runs 4.7.11; `wrangler deploy` is left to the
  operator.

## [4.7.12] - 2026-09-29

### Added
- **Sanitized payload strings carry a shape class.** A sanitized structure
  recorded every string as `{type, length}`, and a length cannot be
  attributed: two different values can share one, so "this field changed
  size" is equally consistent with a notebook reference appearing, vanishing,
  or never having been there. That is what left the replay-path question
  unanswerable — KAN-195's two samples differed in exactly one field's length
  and nothing else. Each string now also carries `cls` from a closed set of
  protocol shapes (`notebook_ref`, `url`, `uuid`, `build_label`, `json_blob`,
  `opaque`), so the question becomes "does any field carry a notebook
  reference" — one bit per field, decided by the protocol rather than by the
  person typing. No prefix, substring, hash or first-N of any string is
  recorded, so a prompt lands in `opaque` with nothing kept (GUARDRAILS
  G1.2.1).
- **A payload probe that ships switched off.** It reads the sanitized
  structures above and writes them to the page console — the only sink that
  cannot persist anything. Toggled at runtime rather than hand-inserted, so a
  later capture costs one message instead of a commit, a build and a reload,
  and a debugging aid cannot be left enabled in a build that goes out.

### Fixed
- **The canary that checks the guardrail did not detect a leak.** Its first
  version asserted that the whole prompt and the tokens `lesson4` and
  `FORTUNE` were absent from the sanitized output — all three sit past the
  eighth character, so `prefix: val.slice(0, 8)` passed it. The canary now
  sweeps every 6-character window of the prompt and fails under that
  mutation. A leak detector that only looks where the leak is not is the same
  defect this project has now met at four different layers.

### Notes
- The version line is unified: worker, npm package, lockfile and extension
  manifest ship as one version, and `version-consistency.test.mjs` makes a
  partial bump a hard failure rather than a production surprise.
- Not deployed. The worker still runs 4.7.11; `wrangler deploy` is left to the
  operator. The change is extension-side only, so the probe works without it.

## [4.7.11] - 2026-09-29

### Fixed
- **A dead extension context looked healthy.** Reloading the extension at
  `chrome://extensions` invalidates every live content script:
  `chrome.runtime.id` becomes undefined and later `chrome.*` calls throw. The
  page keeps the old script and it cannot re-inject itself, so the only
  remedy is a tab reload — but nothing said so. Observed live: the worker
  reported `extension_status: DISCONNECTED` while the on-page indicator still
  read "Bridge: Online" in healthy green, because the stale script never
  receives a disconnect notice and simply renders the last state it was told.
  Anyone checking the UI concluded the bridge was fine. Meanwhile
  `initCentralCoordinator` retried `chrome.runtime.connect()` every second
  against a runtime that no longer existed, emitting an endless stream of
  identical "Attempting reconnect..." warnings that all said the same
  unactionable thing.

  All four reconnect sites now check `chrome.runtime.id` first. A missing
  runtime calls `markExtensionStale()`, which puts the indicator into a
  distinct `stale` state — purple `#a855f7`, no pulse — reading "Reload this
  tab (extension reloaded)". The remedy names the tab, not the extension,
  because reloading the extension is what caused the state. The notice is
  latched so reconnects cannot flicker it, and its indicator write is wrapped
  in try/catch so a cosmetic failure cannot break recovery.

  `tests/extension-stale-context.test.mjs` pins the detection on every retry
  site, the distinct colour, the actionable text, the latch, and the
  declaration order of the flag (a `let` read from a path that can run during
  init would be a temporal-dead-zone crash).

## [4.7.10] - 2026-09-29

### Fixed
- **Auto-focus could not report its own failure.** A grounded call needs the
  Gemini tab in the foreground; the extension now asks the background script
  to focus it (`REQUEST_TAB_FOCUS` → `chrome.tabs.update` +
  `chrome.windows.update`) and polls `document.visibilityState` for up to 2s
  instead of sleeping a flat 200ms. The first version polled and then
  *discarded the boolean*, which made the wait cosmetic: a tab that never came
  forward still ran the full attach/typing path and failed much later, inside
  the module, as `tab_not_visible` — the identical reason a genuinely hidden
  tab produces. The log then read as a UI or selector problem when the real
  cause was "Chrome never focused the tab", and the two are indistinguishable
  afterwards. Both handlers now bail on a timeout with the distinct reason
  `tab_never_visible` and `step: "visibility"`, so a failed focus is legible
  instead of masquerading as a UI failure. `waitForTabVisible` also treats a
  document with no `visibilityState` as visible, matching the modules'
  `isTabVisible()` rule — failing closed there would wedge every test rig and
  embedder lacking the Page Visibility API.

## [4.7.9] - 2026-09-29

### Fixed
- **The collector could never see the answer it was waiting for.** Live run 6: `horo_consult` returned 1/1 `answered` with `last_grounding_status = grounded` on the first call, but the second consecutive call failed with `no_answer_rendered, responses on screen=3` — while the DOM showed a third `user-query` carrying the notebook, so the prompt had in fact been sent. The baseline was sampled in `handleCollectAnswer`, i.e. when the worker asked for the answer, and Gemini can render a response *before* that request arrives; the collector was therefore already looking at the answer it was waiting for and correctly, but uselessly, concluding that nothing newer existed. The count is now sampled in `typeAndSend` **before** the send button is clicked and carried through `TYPE_PROMPT_RESULT` → `collectTypedAnswer` → `COLLECT_ANSWER` as `responsesBefore`, so the baseline predates the request it attributes. This is the same lesson as 4.7.8 — a measurement taken too late is not evidence — and the acceptance condition for KAN-182 is two *consecutive* grounded calls, which is exactly the case the old ordering could not express.

## [4.7.8] - 2026-09-29

### Fixed
- **A correctly grounded answer was reported as ungrounded.** Live run 5 on 4.7.7 was the first to reach the end of the chain: the notebook attached, the typed prompt landed, a new conversation was created (`/app` → `/app/c717b39dd73233a4`), a `user-query` rendered, and the answer streamed. The verdict was still `no_citations_in_response` — but the settled response carried **nine** `source-inline-chip` elements citing *"PDF: FORTUNE_original_lesson4.pdf"*, a file from the Horo notebook. A grounded answer streams its citations in *after* its text, and the check read once, immediately, so it judged a still-streaming response. `handleVerifyGrounding` now polls until the citations appear and only concludes "ungrounded" once three consecutive samples show the newest response unchanged — an unchanged response is a finished one, so that verdict is a real answer rather than a guess. The worker's budget was raised to 35s to cover the wait.

## [4.7.7] - 2026-09-29

### Fixed
- **A notebook-grounded answer was being produced by a path that cannot ground.** Live run 4 captured the request on the wire: the `StreamGenerate` POST went out as `resourceType: "fetch"` (the page's own calls are `xhr`) with no `f.sid`/`hl=th`, and the decoded body was `f.req=[null,"[[\"Act as ซินแส AI …\",0,null,…],…]"]` — the bare prompt, **no `notebook://…/sources/…` reference at all**. So the replay path had started working, was returning a perfectly good answer, and was rendering nothing in the page. Two consequences: the answer was written from general knowledge by construction, and the grounding check had no `model-response` to read, which is why 4.7.6 reported `no_response_rendered` with zero queries and zero responses on screen. Replay is not a neutral fallback — it cannot carry a notebook attachment, because the attachment only exists in the request the **page** builds. `executeThroughExtension` now takes `requireGrounding`, set for a default-scoped `horo_consult`, and skips replay entirely in favour of the typed path. This is the first version where the notebook attach and the answer come from the same request.

## [4.7.6] - 2026-09-29

### Fixed
- **The prompt write was reported as successful on a value Angular had already reverted** (live run 3 on 4.7.5 showed the MAIN-world relay being reached, yet the editor returning to `ql-blank`): the relay read the editor back *immediately* after `quill.setText`, which is a transient value, and treated it as proof. It now waits for a change-detection turn and reports the **settled** state, and settledness is read from the `ql-blank` class rather than the text — that class is precisely what Angular restores, so it distinguishes "landed and I looked too early" from "rejected outright". Retries are bounded and only re-apply while the editor is still blank.
- **The write is now pushed into Angular's model, which is what makes it persist**: `quill.setText(t, "user")` does emit Quill's `text-change`, but from a MAIN-world script it runs outside `NgZone`, so the `ControlValueAccessor`'s `onChange` never reaches the `FormControl`. The form value stays `""` and the next change-detection pass calls `writeValue("")`, resetting the editor. `syncAngularModel()` uses the Angular debug API (`ng.getComponent` / `ng.getDirectives` / `ng.applyChanges`, trying `formControl`/`control`/`model`/`value`) to set the bound value, and an `input` event is dispatched first so Zone.js has a native event to hook. Both are best-effort: the result reports `ngSynced` so a live run says whether the debug API was reachable, which is what distinguishes "retry longer" from "only a trusted event can get through".

### Not unit tested
The MAIN-world typing logic in `injected.js` is a side-effecting IIFE (it installs
a `message` listener and patches `fetch` on load) and cannot be `require`d in the
Node test environment — `ReferenceError: window is not defined`. The 4.7.6 settle
and Angular-sync behaviour is therefore **verified by live run only**, not by
unit tests. Writing tests for it needs a `window`/`document` harness, which is
follow-up work; do not assume it is covered.

## [4.7.5] - 2026-09-29

### Fixed
- **The prompt could not be typed at all, for an architectural reason** (the root cause behind 4.7.3's failed live run): content scripts run in Chrome's ISOLATED world, which shares the DOM with the page but **not JavaScript expandos**. The `__quill` property Angular sets on `rich-textarea` lives in the page's own context, so `getQuill()` in the content script returns `null` no matter how the lookup is written — and every isolated-world write (`textContent`, a synthetic `InputEvent`, `execCommand`) is reconciled away by Angular, leaving the editor `ql-blank` with no prompt ever sent. Typing is now relayed to `injected.js`, which already runs in the MAIN world via `world: "MAIN"`, over the existing `postMessage` bridge (`TYPE_PROMPT_INTO_EDITOR` → `PROMPT_TYPED`). It drives `quill.setText(text, "user")` from the world that owns the instance, and replies with the editor's actual text so the isolated side verifies rather than assumes. The DOM writes remain as a last resort for a page where the MAIN world never answers, which now times out after 5s and falls back instead of hanging. No `chrome.debugger` permission is required.
- **A missing `InputEvent` could discard a write that had already landed**: the fallback wrapped the `textContent` assignment and the event dispatch in one `try`, so an environment without `InputEvent` reported failure for a write that had in fact succeeded. They are guarded separately now, and the mandatory read-back decides.

## [4.7.4] - 2026-09-29

### Fixed
- **An answer could not be attributed to the request that asked for it** (surfaced by running 4.7.3 live, where `collectTypedAnswer` reported success while the `user-query` count never moved): `waitForResponseChange()` compared the newest response's *text* against the text captured at the start. A conversation keeps every earlier reply, so when the prompt never reached Gemini the newest response was still the previous turn's answer — stable, non-placeholder, and different from the start snapshot if anything re-rendered mid-wait. Text cannot tell "the answer to my question" from "an answer that happens to be on screen"; the response **count** can. The wait now takes a `minResponses` floor and requires a strictly newer response, and `handleCollectAnswer` re-checks it after the streaming settle. `retryViaUi` passes `minResponses: 0` because regenerate re-renders in place rather than appending. The failing reason is now `no_new_response_rendered` and reports how many responses the page held, instead of the misleading `no_citations_in_response` from grading a response the caller never asked for.

## [4.7.3] - 2026-09-29

### Fixed
- **The typed prompt was never actually typed** (found by running 4.7.2 live): `setPromptText()` required a `__quill` JS property on `rich-textarea`, which was not reachable on the live tab. With no Quill instance the old fallback assigned `textContent` and dispatched a synthetic `InputEvent`, and Angular reconciled the editor straight back to `ql-blank` — the prompt was never sent, and combined with the 4.7.2 stale-answer bug the tool reported the previous turn's text. `getQuill()` now also checks the inner `.ql-editor` and is treated as best-effort; the primary path is `execCommand('insertText')` on the focused editor, which emits the real `beforeinput`/`input` pair Quill's own listeners react to. Verified live: real input events clear `ql-blank`, surface the send button, and submit — a 9th `user-query` appeared. No `chrome.debugger` permission needed, and `textContent` alone is still never the primary path (it doubles the text when it works at all).

## [4.7.2] - 2026-09-29

### Fixed
- **Stale answers were returned as if they were this call's own** (surfaced by the 4.7.1 grounding check on its first live run): `waitForResponseChange()` resolved `{changed:false, text:<the last model-response>}` on timeout, and `executeThroughExtension` adopted that text unconditionally — `text = collected.text`, with the `ok` flag ignored. When a typed prompt failed to land, `horo_consult` answered with the **previous** turn's text and then failed grounding on it, reporting `no_citations_in_response` and pointing the operator at the notebook when no question had been asked at all. Two different faults, one misleading symptom. A timeout now returns empty text, and an unreadable answer raises its own error instead of being graded as an ungrounded one.

## [4.7.1] - 2026-09-29

### Fixed
- **`horo_consult` reported ungrounded answers as grounded (the notebook attaches per MESSAGE, not per conversation)**: `notebook-attach.js` short-circuited the attach whenever a chip was already in the input area and returned `{ok:true, alreadyAttached:true}`. Grounding is consumed per message — measured from real `StreamGenerate` payloads on 2026-09-29, a prompt sent after the chip was spent carries **no** `notebook://…/sources/…` reference at all — so from the second `horo_consult` call onward the answer was written from general knowledge while the tool reported it as grounded, and nothing in the returned text let the caller tell. A leftover chip is now cleared and the full attach flow always runs, guaranteeing exactly one fresh reference per submitted prompt. Re-attaching does not stack: the payload carries exactly one set of references.
- **Grounding is now verified, not assumed**: `attached` and `verified` are separate claims. `notebookGrounding.verified` is decided *after* the answer streams, from the citations in that answer, and an unverified answer returns JSON-RPC `-32000` rather than a plausible-looking ungrounded reading. `check_bridge_health.notebook` reports `last_grounding_status` separately from `last_attach_status`, because an attach can succeed while every answer that follows is ungrounded — reading only the attach status called that healthy.

### Added
- **`VERIFY_GROUNDING` / `GROUNDING_RESULT` protocol messages** and `NotebookAttach.readGroundingEvidence()`, which reads citations from the **newest** `model-response` only. Scoped deliberately: `source-inline-chip` elements from earlier replies stay in the DOM for the life of the conversation, so a document-wide scan finds citations belonging to a grounded answer several turns back. Confirmed against the live DOM — a 7-response conversation held 2 chips in the 5th response while the newest 2 responses had none.
- **Prompt typing fallback (`prompt-typing.js`, KAN-182)**: asks through Gemini's own input box when the replay path produces no chunk. The bridge's assembled `StreamGenerate` payload is refused by a schema change on Google's side, so the question never leaves the browser (0 `user-query` / 0 `model-response` rendered, 60s timeout). Text is set through `quill.setText(text, "user")` — `'api'` renders the text but never surfaces the send button, and `textContent` lands the prompt twice. No `chrome.debugger` permission is required.
- **`TYPE_PROMPT` / `COLLECT_ANSWER` protocol messages** so the worker can read an answer back out of the page after a typed submit.

## [4.4.3] - 2026-09-26

### Fixed
- **`decodeChunk` truncation of LMDX / `lmdx_content` answers**: the decoder took the **last** `wrb.fr` text in a buffer while the caller **replaces** its accumulator (Gemini re-sends the cumulative answer). Gemini appends a private conversation link (`https://googleusercontent.com/lmdx_content/...`) and can emit LMDX UI-component entries in their own `wrb.fr`, so a finished answer was overwritten by that trailing fragment — long SDLC output (`orchestrate_sdlc_plan`) came back link-only, truncated or empty. The decoder now keeps the longest coherent text, and `executeThroughExtension` only adopts an update that is at least as complete as what it already holds.
- **`decodeChunk` text-slot shapes**: the positional slot (`innerData[4][0][1]`) is handled whether it is a string, an array of segments, or a structured LMDX block; previously a plain string degraded to its **first character** and structured blocks were dropped silently.
- **`decodeChunk` state loss on malformed payloads**: a `JSON.parse` failure inside one `wrb.fr` no longer discards the rest of the line (which also carried `conversationId` / `responseId`).
- **Private link leakage**: the trailing `googleusercontent.com/lmdx_content/...` link is stripped from answers before they reach API/MCP clients.
- **Blank-success tool results**: a decoded-empty model answer now returns JSON-RPC error `-32000` (`Empty model response …`) and, when configured, falls back to GCP Gemini — instead of a successful result with empty `content`. A link-only answer counts as empty.
- **SDLC tool argument contract**: the docs advertised `problem_description` for all four SDLC tools while the schemas used per-tool names, so `orchestrate_sdlc_plan` prompted `Goal: undefined`. All four tools now accept the documented alias (`orchestrate_sdlc_plan`: `feature_or_goal` | `problem_description`; `code_review_and_debug`: `code_snippet`; `evaluate_tech_tradeoffs`: `decision_context`) and return `-32602` with the missing argument name instead of calling Gemini with `undefined`. README/HANDOFF parameter tables corrected.
- **`/health` counters were dead**: `healthState` is a derived getter that rebuilds an object per read, so every `this.healthState.consecutiveErrors++` / `lastError = …` write mutated a throwaway copy — production always reported `consecutive_errors: 0, last_error: null` and the `check_bridge_health` "degraded" threshold could never fire. All writes now go through `recordHealthError()` / `recordHealthSuccess()`.
- **Version drift**: `/health`, MCP `serverInfo` and `ping` reported a hardcoded `4.3.4` while `package.json` said `4.3.7` and the extension manifest said `4.4.3`. All version strings now read a single `WORKER_VERSION` constant, and `package.json` / `package-lock.json` / `manifest.json` are pinned to the same release line.

### Security
- `wrangler.staging.toml` no longer ships a plain-var `BRIDGE_SECRET` (was the guessable `staging-token-change-me`); the worker now fails closed until the secret is set with `wrangler secret put`.

### Added
- `tests/decode-chunk.test.mjs` (9 cases: cumulative text, trailing `lmdx_content` link, string/array/structured text slots, malformed-payload state recovery, non-JSON lines).
- `tests/sdlc-tool-args.test.mjs` (6 cases: documented alias, canonical argument, missing-argument errors, empty/link-only answers, trimmed result).
- `tests/health-metrics.test.mjs` (2 cases: counters persist across reads and surface in `/health` + `check_bridge_health`).
- `tests/version-consistency.test.mjs` (4 cases: `WORKER_VERSION` ↔ `package.json` ↔ `package-lock.json` ↔ extension manifest, and no hardcoded version literals left).

### Fixed (Chrome extension runtime)
- **Refresh-teardown error spam**: Page refresh no longer logs spurious `[Bridge] WebSocket Error` and `[Bridge] Disconnected (code: 1006)` warnings. Added `isRefreshing` flag via `beforeunload`/`pagehide` detection to suppress expected WebSocket teardown noise.
- **EvidenceRegistry init race**: `saveToStorage()` now defers writes until `init()` completes via `initialized` guard, eliminating the race between async `registry.init()` and SESSION_STATE evidence recording that triggered `Context invalidated during save` on refresh.
- **Context-invalidation classification**: `saveToStorage()` now classifies context-invalidation errors as PERMANENT (orphaned — retry can never succeed after an extension reload/update, only a tab reload helps) instead of silently skipping. Orphaned saves stay fully silent (no `Context invalidated during save` warning); transient failures (timeout/quota) set `_hasPendingWrites` and are retried on the next save cycle, also silently. `init()` restores the in-memory snapshot on orphaned load with no warning and never flushes. A one-time `onOrphaned` hook lets content.js surface a single `Bridge: Reload tab (extension updated)` pill hint via the deduping indicator.
- **CSP manifest-src noise**: the Gemini page's own `manifest-src 'none'` policy (Google fetches its internal manifest against its own policy) no longer logs `[Gemini Bridge] CSP manifest-src violation … [object SecurityPolicyViolationEvent]`. Site-side violations are ignored silently; only extension-attributable violations are logged with structured fields. Removed the no-op `event.preventDefault()` (`SecurityPolicyViolationEvent` is not cancelable).
- **New tests**: Added 4 test cases covering orphaned-save silence + no-retry, timeout TRANSIENT classification, orphaned-init snapshot restore, and one-time `onOrphaned` hook firing.

### Added
- Refresh/teardown detection event listeners in content.js (`beforeunload`, `pagehide`, `pageshow`).
- `_hasPendingWrites` tracking and flush mechanism in EvidenceRegistry.

### KAN-126
- **horo_consult scope isolation (fixed)**: `horo_consult` intentionally defaults to the HoroConsultant knowledge Notebook (`notebook:b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0`) so BaZi answers stay grounded in that notebook. The scope switch was never undone, so a single unscoped `horo_consult` call left the session (and the extension tab) pinned to the Notebook, and every following unscoped tool call silently inherited it. Tool execution is now wrapped in `runInPreparedScope()` with a `finally` scope restore, covering the success, error, GCP-fallback and extension-disconnected paths; `switchedScope` is derived from session state so a fail-closed `applyScope` also restores. Tool arguments are per-call, not a session mutation — an explicitly passed `scope` is now also restored afterwards.
- **Scope transparency (added)**: every successful tool result carries `bridgeScope: { used, active, restored }` so MCP clients can see which scope actually served the answer.
- **Default scope documentation (changed)**: all tool `scope` descriptions now state the default explicitly — `https://gemini.google.com/app` for the four SDLC tools (they inherit the session scope, which defaults to App), and the HoroConsultant Notebook + restore behaviour for `horo_consult`.
- **New tests**: 5 regression tests covering default-switch-then-restore, explicit-scope-then-restore, no-op when the requested scope equals the current one, restore on execution failure, and that unscoped SDLC tools never trigger a scope switch.

### KAN-123
- Structured cross-functional review (KAN-122) applied: Option B selected after Red Team, Blue Team, Worker Specialist, and Research perspectives.

## [4.3.7] - 2026-09-23

### Fixed
- **EvidenceRegistry async race condition**: `init()` no longer regenerates session epoch or clears records that were auto-verified during the async storage wait. Snapshot-and-preserve pattern ensures `verified` records with valid `mappingRevision` survive across the `await` boundary.
- **Extension packaging**: Added `scripts/zip-extension.py` and CI job (`package-extension`) to produce versioned, installable extension zips automatically. Previously, incorrect zip structure (including `node_modules/` or missing `manifest.json`) made Chrome refuse to load the extension.

### Automation
- CI: New `package-extension` job zips `extension-cloudflare/`, validates `manifest.json`, and uploads as `gemini-bridge-extension` artifact (90-day retention).
- Git: `release/` added to `.gitignore` (build artifact, not committed).
- Local build: `python3 scripts/zip-extension.py` produces `release/gemini-bridge-v{X.Y.Z}.zip`.

## [4.3.6] - 2026-09-19

### Added
- Manifest version bump for extension reload.

## [4.3.4] - 2026-09-18

### Changed
- Worker stability patch: Exclusive SW channel & rogue socket elimination.

## [4.2.0] - 2026-09-12

### Changed
- Initial Cloudflare Workers deployment.
