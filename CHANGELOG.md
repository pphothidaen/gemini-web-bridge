# Changelog

All notable changes to the Gemini Web-Bridge project.

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
