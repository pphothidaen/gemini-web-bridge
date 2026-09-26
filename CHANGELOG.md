# Changelog

All notable changes to the Gemini Web-Bridge project.

## [4.4.3] - 2026-09-26

### Fixed
- **Refresh-teardown error spam**: Page refresh no longer logs spurious `[Bridge] WebSocket Error` and `[Bridge] Disconnected (code: 1006)` warnings. Added `isRefreshing` flag via `beforeunload`/`pagehide` detection to suppress expected WebSocket teardown noise.
- **EvidenceRegistry init race**: `saveToStorage()` now defers writes until `init()` completes via `initialized` guard, eliminating the race between async `registry.init()` and SESSION_STATE evidence recording that triggered `Context invalidated during save` on refresh.
- **Context-invalidation classification**: `saveToStorage()` now classifies context-invalidation errors as PERMANENT (orphaned — retry can never succeed after an extension reload/update, only a tab reload helps) instead of silently skipping. Orphaned saves stay fully silent (no `Context invalidated during save` warning); transient failures (timeout/quota) set `_hasPendingWrites` and are retried on the next save cycle, also silently. `init()` restores the in-memory snapshot on orphaned load with no warning and never flushes. A one-time `onOrphaned` hook lets content.js surface a single `Bridge: Reload tab (extension updated)` pill hint via the deduping indicator.
- **CSP manifest-src noise**: the Gemini page's own `manifest-src 'none'` policy (Google fetches its internal manifest against its own policy) no longer logs `[Gemini Bridge] CSP manifest-src violation … [object SecurityPolicyViolationEvent]`. Site-side violations are ignored silently; only extension-attributable violations are logged with structured fields. Removed the no-op `event.preventDefault()` (`SecurityPolicyViolationEvent` is not cancelable).
- **New tests**: Added 4 test cases covering orphaned-save silence + no-retry, timeout TRANSIENT classification, orphaned-init snapshot restore, and one-time `onOrphaned` hook firing.

### Added
- Refresh/teardown detection event listeners in content.js (`beforeunload`, `pagehide`, `pageshow`).
- `_hasPendingWrites` tracking and flush mechanism in EvidenceRegistry.

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
