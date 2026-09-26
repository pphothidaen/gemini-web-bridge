# Changelog

All notable changes to the Gemini Web-Bridge project.

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
- `wrangler.staging.toml` no longer ships a plain-var `BRIDGE_AUTH_TOKEN` (was the guessable `staging-token-change-me`); the worker now fails closed until the secret is set with `wrangler secret put`.

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
