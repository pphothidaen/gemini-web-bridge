# Phase Progress Summary

> **Status: UNVERIFIED WORK IN PROGRESS — not integrated, not deployed.**
> Committed under a ticket for traceability only. Read this before trusting any
> "✅ Complete" below: those markers describe *code written*, not *code proven*.
>
> What is actually true as of this commit:
>
> - **All 5 files under `src/` and `scripts/` are dead code.** `wrangler.jsonc`
>   sets `"main": "cloudflare-worker/src/index.js"`, and `src/index.js` imports
>   none of them. Nothing in the deployed worker calls the search proxy, the
>   guardrail, or the sandbox.
> - **The 25 tests in this workstream do not test behaviour.** Every assertion is
>   `source.includes('<literal>')` against a `.ts` file. Several assert on
>   comments and formatting (`'Exponential backoff'`, `'Avoids VM2/E2B'`,
>   `'Docker-backed'`), so reformatting the file or fixing a typo in a comment
>   turns them red without any behaviour changing. A green run here is not
>   evidence that anything works. This is the same defect class as KAN-192
>   (a test asserting a version string, not the code) and KAN-197/198 (a test
>   written to agree with whatever the code did).
> - **The Phase 4 CLI does not run.** `node scripts/sandbox-server.js` fails with
>   `ReferenceError: ExecutionRequest is not defined` at `src/sandbox.ts:683` —
>   `export default { ExecutionRequest, ... }` exports a TypeScript *type* as a
>   runtime value. Verified on Node v26.7.0.
> - **There is no TypeScript toolchain.** No `tsconfig.json`, and `typescript` is
>   not a dependency. The `.ts` files are only ever read as text; nothing in the
>   repo type-checks or compiles them.
>
> What would make this real: behavioural tests that import the modules and assert
> on return values, a real `tsconfig.json` + `typescript` devDependency, and a
> decision on whether code execution belongs in this worker at all — `DockerSandbox`
> runs arbitrary code in a networked process, and neither `GUARDRAILS.md` nor
> `ARCHITECTURE.md` currently mentions Docker or code execution.

## Phase 1: Foundation ✅ Complete
- Worker architecture (Durable Objects, WSS Protocol v2)
- Health monitoring endpoints
- Model catalog sync

## Phase 2: Search Proxy ⚠️ Written, unverified
**File:** `src/search-proxy.ts` (8,260 bytes, 311 lines)
**Features:**
- SearchProxy class with configurable timeout, retries
- execute() - single query with guardrail processing
- executeWithRetry() - exponential backoff retry logic
- executeBatch() - concurrent batch execution
- HttpSearchProxy - HTTP implementation example
**Dependencies:** Guardrail (Phase 3) integration
**Not imported by `src/index.js`. Not covered by behavioural tests.**

## Phase 3: Output Guardrail ⚠️ Written, unverified
**File:** `src/guardrail.ts` (9,852 bytes, 355 lines)
**Features:**
- 3-tier processing: truncate → summarize → spill_to_file
- Presets: development, staging, production
- Production preset: maxChars=30000, truncateAt=3000, spillThreshold=10000
- Content filtering with regex patterns
- Statistics tracking (processedCount, filteredCount)
**Integration:** processResult() called by SearchProxy.execute() — but neither is reachable from the worker
**Not imported by `src/index.js`. Not covered by behavioural tests.**

## Phase 4: Code Execution Sandbox ⚠️ Written, BROKEN
**File:** `src/sandbox.ts` (19,214 bytes, 688 lines)
**CLI:** `scripts/sandbox-server.js` (3,701 bytes) — **currently crashes, see above**
**Features:**
- Docker-backed execution (avoids VM2/E2B per Red Team/Worker findings)
- Resource limits: memory, CPU, PID, read-only filesystem
- Network isolation by default
- Stateful Python sessions via sessionId + __sandbox_state
- WebSocket API for real-time execution
- CLI server script

**Dependencies:** `ws` — manifest declares `^8.16.0`; lockfile and `node_modules` both resolve `8.21.0`

## Test Coverage
| Test File | Tests | What they actually assert |
|-----------|-------|---------------------------|
| tests/sandbox.test.mjs | 9 | 9 × `source.includes()` on `src/sandbox.ts` |
| tests/search-proxy-guardrail.test.mjs | 16 | 16 × `source.includes()` on the two `.ts` sources |

These run as part of `npm test` (`tests/**/*.test.mjs`), so they contribute to
the suite tally below while verifying no behaviour whatsoever.

**Full suite, measured:** **544 pass / 0 fail / 5 skipped** (549 tests).
The 5 skipped are pre-existing. There is **no** "pre-existing auth test failure"
— an earlier version of this file claimed one; that was wrong.

## Dependency Summary
```json
{
  "dependencies": {
    "pdf-lib": "^1.17.1",
    "ws": "^8.16.0"
  }
}
```
(`ws` was already a dependency before this workstream; this workstream did not add it.)

## Architecture Notes
- Phase 2-3 use TypeScript with `.ts` extension — **source-inspection only, no compilation**
- Phase 4 sandbox is Docker-based, designed for Hermes execute_code integration
- All components are modular in intent; none is reachable from the deployed worker
- Phase 5 rollout is ⏳ PENDING per `PHASE5_EXECUTION_REPORT.md` (13/18 scenarios,
  5 outstanding, 3 of which need a browser)
