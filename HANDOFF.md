# 🧭 Master Project Handoff & Architecture Blueprint

> ## ⚠️ HISTORICAL PRODUCTION HOST WARNING
>
> **Do NOT point clients at the RETIRED production host:** `gemini-web-bridge.pansakorn-pho.workers.dev`.
> That host was retired by the Cloudflare account migration in `fa97a5d` and is kept only as a rollback target.
> Its extension is permanently `DISCONNECTED`, and its `/v1/models` always returns `data: []`.
>
> **Canonical Production Host:** `https://prod.gemini-web-bridge.workers.dev`  
> **Current Version:** `v4.7.34`  
> **Test Baseline:** 694 tests (684 pass, 0 fail, 10 skipped) — 100% green suite · KAN-242 Context Rotation implemented & verified  
> **Active Working Documents:** [`SESSION_HANDOFF-2026-10-04.md`](SESSION_HANDOFF-2026-10-04.md) · [`docs/SESSION_HANDOFF-2026-10-04.md`](docs/SESSION_HANDOFF-2026-10-04.md) · [`docs/verification/kan242-context-rotation-design.md`](docs/verification/kan242-context-rotation-design.md) · [`docs/CLOUDFLARE-DASHBOARD-BUILDS-DISABLE.md`](docs/CLOUDFLARE-DASHBOARD-BUILDS-DISABLE.md) · [`docs/api-spec.md`](docs/api-spec.md)

---

> **Gemini Web Bridge (Edge AI Gateway & Hybrid Hub)**  
> **Document Version:** `v4.7.34`  
> **Repository:** `gemini-web-bridge`  
> **System Status:** Production Ready & Operational (Zero Known Defects)  
> **Last Verified Date:** 2026-10-04

---

## 📑 Table of Contents

1. [System Overview & Current Baseline](#1-system-overview--current-baseline)
   * 1.1 Objective & Key Capabilities
   * 1.2 Multi-Layer Architecture (4-Layer Extension + Edge Hub)
   * 1.3 Execution Path Bifurcation: UI Typing (Grounded) vs Replay
   * 1.4 Live Endpoints & Parity (/v1, /v2, /mcp, /artifacts)
2. [Wire Protocol v2, Envelopes & Lifecycle](#2-wire-protocol-v2-envelopes--lifecycle)
   * 2.1 ScopeRouter & JSON-RPC Envelopes
   * 2.2 Extension Protocol Messages & Progress Heartbeats
   * 2.3 Idle-Based Collection Deadline & Hard Cap
   * 2.4 DO Alarms & Keepalive Management
3. [Conversation Scopes & Grounding Mechanics](#3-conversation-scopes--grounding-mechanics)
   * 3.1 Normal Chat (`app`) vs NotebookLM (`notebook`)
   * 3.2 In-Place Notebook Attachment (Zero-Navigation)
   * 3.3 Post-Generation Citation Verification (Fail-Closed)
4. [Remote MCP Tools (9 Production Tools)](#4-remote-mcp-tools-9-production-tools)
   * 4.1 Tool Catalog & Schemas
   * 4.2 Deep Dive: `horo_consult` & PDF Export (`ARTIFACT_KV`)
   * 4.3 JSON-RPC Request & Response Examples
5. [DOM Signal Contract & Reliability](#5-dom-signal-contract--reliability)
   * 5.1 Empirical Verification via `dom-signal.mjs`
   * 5.2 Localization-Proof UI Selectors
6. [Milestone History & Architectural Evolution](#6-milestone-history--architectural-evolution)
   * 6.1 Evolution Milestones (v1.0.0 → v4.7.33)
   * 6.2 Major Architectural Tickets (KAN-168 to KAN-249)
7. [Deployment & CI/CD Governance](#7-deployment--cicd-governance)
   * 7.1 Single Authority: GitHub Actions CD (`cd.yml`)
   * 7.2 Cloudflare Workers Builds Failure Context & Resolution
   * 7.3 Secrets Management (Doppler & Cloudflare Secrets)
8. [Operational Runbook & Diagnostics](#8-operational-runbook--diagnostics)
   * 8.1 Extension Loading & Verification
   * 8.2 Automated Test Execution (659 Tests)
   * 8.3 Live Verification Commands
   * 8.4 Troubleshooting Matrix
9. [Security Guardrails (G1–G5)](#9-security-guardrails-g1g5)
10. [Forward Roadmap Status](#10-forward-roadmap-status)

---

## 1. System Overview & Current Baseline

### 1.1 Objective & Key Capabilities

**Gemini Web Bridge** is an enterprise-grade Edge-to-Browser AI Gateway that bridges external AI clients (Claude Code, Hermes Agent, Cursor, Cline, Python SDK, cURL) with an authenticated Google Gemini web session running in Google Chrome.

Core capabilities:
- **Zero Token Leak (G1)**: Captures Google session CSRF token (`SNlM0e`) exclusively in volatile browser RAM; never transmits tokens over the wire.
- **Bifurcated Execution**: Dispatches via Replay (StreamGenerate) for low-latency streaming and UI Typing for grounded and complex tools.
- **Notebook Grounding**: In-place attachment of NotebookLM notebooks with strict, fail-closed citation verification (`notebookGrounding.verified = true`).
- **Resilient Connectivity**: Background service worker WebSocket ownership, idle-based collection deadlines with progress heartbeats, and DO keepalive alarms.

---

### 1.2 Multi-Layer Architecture

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                   AI Clients Tier                                      │
│           Hermes Agent · Cursor · Cline · Claude Code · Python SDK · cURL              │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │ HTTPS (Bearer Auth: CLIENT_API_KEY)
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                   Cloudflare Edge Tier (prod.gemini-web-bridge.workers.dev)            │
│                                                                                        │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │                         Edge Routing & Security Middleware                     │   │
│   │   • Bearer Auth (keyed on literal path; /health public, /v1/health protected)  │   │
│   │   • Dual API Version Router (resolveApiVersion: /v1 frozen, /v2 byte-parity)   │   │
│   │   • Artifact Storage Gateway (/artifacts/{key} -> ARTIFACT_KV, 1h TTL)         │   │
│   └──────┬────────────────────────┬────────────────────────┬───────────────────────┘   │
│          │                        │                        │                           │
│          ▼                        ▼                        ▼                           │
│   ┌──────────────┐         ┌──────────────┐         ┌──────────────┐                   │
│   │ /v1 & /v2    │         │  Remote MCP  │         │ Status & Dbg │                   │
│   │ Completions  │         │  /mcp        │         │ /health      │                   │
│   │ & Models     │         │  (9 Tools)   │         │ /debug/payl. │                   │
│   └──────┬───────┘         └──────┬───────┘         └──────┬───────┘                   │
│          └────────────────────────┼────────────────────────┘                           │
│                                   ▼                                                    │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │                 GeminiBridgeDO (Stateful Durable Object Instance)              │   │
│   │   • Global Singleton ("global-bridge") with SQLite Migration Support           │   │
│   │   • ScopeRouter: Envelope-based JSON-RPC (exact, prefix app:*, notebook:*, *) │   │
│   │   • Idle-Based Collection Deadline (slides on heartbeat, enforced hardCap)     │   │
│   │   • DO alarm(): 120s keepalive PINGs, SSE : keepalive, and stale socket reap   │   │
│   │   • FIFO Queue (1 concurrent, max 10 waiters, 60s queue deadline)              │   │
│   │   • Artifact Exporter: Builds PDF and writes to ARTIFACT_KV (1h expiration)    │   │
│   └───────────────────────┬────────────────────────────────┬───────────────────────┘   │
│                           │                                │                           │
│                           │ WebSocket (WSS Protocol v2)     │ Fallback on Offline/Error │
│                           ▼                                ▼                           │
│   ┌──────────────────────────────────────────────┐ ┌───────────────────────────────┐   │
│   │  Chrome Extension (Manifest V3 Background)   │ │  Google Cloud Platform (GCP)  │   │
│   │  • background.js (Socket Owner, Keep-Alive)  │ │  • Gemini Flash / Pro API     │   │
│   │  • chrome.alarms 1m keepalive tick           │ │  • X-Provider: gcp-fallback   │   │
│   │  • Tab Coordinator (Leader Election)         │ │    (Excluded from Grounding)  │   │
│   │  • PAYLOAD_CAPTURE_ARM & Focus Relay         │ └───────────────────────────────┘   │
│   └───────────────────────┬──────────────────────┘                                     │
└───────────────────────────┼────────────────────────────────────────────────────────────┘
                            │ chrome.runtime Port Connection
                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                       Google Chrome Tab Runtime (gemini.google.com)                    │
│                                                                                        │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │   Content Script (content.js - Isolated World)                                 │   │
│   │   • SPA Polling (3s) & Navigation Detector                                     │   │
│   │   • prompt-typing.js: Drives editor typing and send trigger                    │   │
│   │   • notebook-attach.js: In-place Notebook attachment & citation verification   │   │
│   │   • native-recovery.js: Emits COLLECT_ANSWER_PROGRESS heartbeats               │   │
│   └───────────────────────┬────────────────────────────────────────────────────────┘   │
│                           │ window.postMessage (TYPE_PROMPT, PROMPT_TYPED)             │
│                           ▼                                                            │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │   Injected Script (injected.js - MAIN World, run_at: document_start)           │   │
│   │   • Zero-Leak CSRF Vault (SNlM0e in RAM only)                                  │   │
│   │   • Quill / Angular Model Sync (quill.setText, execCommand, ng.applyChanges)   │   │
│   │   • Fetch/XHR Interceptor capturing native Gemini StreamGenerate RPCs          │   │
│   │   • Sanitized Payload Probe (relaying shapes to /debug/payload-capture)       │   │
│   └───────────────────────┬────────────────────────────────────────────────────────┘   │
│                           │ Native HTTPS POST (_/BardChatUi/data/assistant.lamda...)   │
│                           ▼                                                            │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │                   Google Gemini Web Production Infrastructure                  │   │
│   └────────────────────────────────────────────────────────────────────────────────┘   │
```

---

### 1.3 Execution Path Bifurcation: UI Typing vs Replay

There is a permanent, deliberate bifurcation between execution paths:
1. **UI Typing Path (Grounded / Complex)**:
   - Driven by `prompt-typing.js` and `notebook-attach.js`.
   - Types into Quill editor, synchronizes Angular state, clicks the send control, and collects settled DOM text.
   - **Used for**: All 4 SDLC tools (`sdlc_solution_architect`, `orchestrate_sdlc_plan`, `code_review_and_debug`, `evaluate_tech_tradeoffs`) and `horo_consult`.
   - **Rationale**: Prevents response truncation and enables verifiable notebook grounding citations.
2. **Replay Path (StreamGenerate)**:
   - Replays direct `StreamGenerate` POST request using captured CSRF credentials.
   - **Used for**: `/v1/chat/completions` and `/v2/chat/completions` SSE streaming.
   - **Constraint**: Cannot carry notebook references; strictly prohibited for grounding-required requests.

---

### 1.4 Live Endpoints & Diagnostics

| Route | Method | Protocol / Auth | Purpose |
|:---|:---:|:---|:---|
| `/health` or `/` | `GET` | Public JSON | Dashboard: connection status, model catalog, collection heartbeat, and API versions. |
| `/v1/models` | `GET` | Bearer Token | Frozen OpenAI Model Catalog. |
| `/v1/chat/completions` | `POST` | Bearer Token | Frozen OpenAI Chat Completion (JSON & SSE Streaming). |
| `/v2/models` | `GET` | Bearer Token | Modernized Model Catalog (byte-identical to v1). |
| `/v2/chat/completions` | `POST` | Bearer Token | Modernized Chat Completion (byte-identical to v1). |
| `/mcp` | `POST`/`GET` | Bearer Token | Remote Model Context Protocol (JSON-RPC 2.0 / SSE) serving 9 tools. |
| `/artifacts/{key}` | `GET` | Public (32-hex Key) | Downloads generated PDF consultation reports from `ARTIFACT_KV` (1h TTL). |
| `/debug/payload-capture`| `GET`/`POST`| Bearer Token | Inspects and arms sanitized `StreamGenerate` payload captures. |
| `/debug/telemetry` | `GET`/`DELETE` | Bearer Token | Queries DO telemetry ring buffer (newest-first, cap 50) or clears it (`DELETE`). |
| `/bridge` | `GET` (Upgrade) | `BRIDGE_SECRET` | WebSocket endpoint for Chrome Extension Background Service Worker. |

---

## 2. Wire Protocol v2, Envelopes & Lifecycle

### 2.1 ScopeRouter & JSON-RPC Envelopes

The Worker DO includes `ScopeRouter`, which multiplexes requests across tabs and contexts using JSON-RPC 2.0 envelopes:
- **Envelope Structure**: `{ jsonrpc: "2.0", id, scope_id, instance_id, method, params, scope_session_id }`.
- **Methods**: `subscribe`, `unsubscribe`, and standard RPC calls.
- **Pattern Matching**: Matches exact scopes (`app`), prefix patterns (`notebook:*`), and default wildcard (`*`).

### 2.2 Progress Heartbeats & Collection Deadline

To prevent long generations (e.g. Gemini thinking phase + large notebook retrieval) from timing out:
1. The extension emits `COLLECT_ANSWER_PROGRESS` every 3 seconds while `isGenerating()` is true.
2. The Worker DO dynamically re-arms its `collectTypedAnswer` timeout from the progress heartbeat.
3. **Hard Cap Enforcement**: The deadline slides up to a strict limit:
   $$\text{hardCap} = \max(\text{timeoutMs} \times 3, \text{timeoutMs} + 60000)$$
   Preventing infinite hangs if a tab enters an unrecoverable state.

### 2.3 DO Alarms (`alarm()`)

Cloudflare DO Alarms wake the DO periodically:
- Broadcasts `{ type: "PING" }` across all tracked tab connections.
- Sends `: keepalive\n\n` comments over open MCP SSE client streams.
- Reaps unresponsive connections that failed to answer PINGs.

---

## 3. Conversation Scopes & Grounding Mechanics

### 3.1 Normal Chat (`app`) vs NotebookLM (`notebook`)
- **Chat Scope (`app`)**: Standard conversational sessions at `https://gemini.google.com/app/<convId>`.
- **Notebook Scope (`notebook`)**: Focused knowledge sessions at `https://gemini.google.com/notebook/<notebookId>`.

### 3.2 In-Place Notebook Attachment & Verification
For `horo_consult`:
1. **Zero Navigation**: Attaches the designated notebook (`notebook:b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0`) in-place into the current `/app` chat tab via DOM dialog automation. Does NOT navigate to `/notebook/` (which is not a chat surface).
2. **Consumed Per Message**: Notebook grounding must be established per prompt.
3. **Fail-Closed Verification**: After text generation completes, `verifyNotebookGrounding` counts `source-inline-chip` elements in the newest response. If zero citations exist, the answer is rejected with error `-32000` (GCP fallback is barred).

---

## 4. Remote MCP Tools (9 Production Tools)

| Tool Name | Scope | Primary Arguments | Description |
|:---|:---:|:---|:---|
| `sdlc_solution_architect` | Typed | `problem_description`, `tech_stack`, `constraints` | System architecture and data flow analysis. |
| `orchestrate_sdlc_plan` | Typed | `feature_or_goal` (or `problem_description`), `current_stage` | SDLC roadmap and phase planning. |
| `code_review_and_debug` | Typed | `code_snippet`, `error_log`, `language` | Bug analysis and security code review. |
| `evaluate_tech_tradeoffs` | Typed | `decision_context`, `options` | Tech trade-off and decision matrix evaluation. |
| `ping` | Direct | `message` (optional) | Health and latency ping. |
| `check_bridge_health` | Direct | *(none)* | Comprehensive health check (DO, WSS, queue, grounding). |
| `list_bridge_models` | Direct | *(none)* | Discovered browser model catalog. |
| `set_bridge_scope` | Direct | `scope` (required) | Swaps active bridge scope. |
| `horo_consult` | Typed | `query` (req), `birth_context`, `response_format` | BaZi consultation grounded in NotebookLM with optional PDF export. |

---

## 5. DOM Signal Contract & Reliability

Defined in `cloudflare-worker/tests/helpers/dom-signal.mjs`:
- All selectors used by the extension are validated against recorded DOM fixtures in `tests/fixtures/`.
- Every test run executes `checkDomSignals()`, failing the build if any selector lacks fixture backing.
- **13 Declared Signals**:
  - `response.generating`: `[aria-busy="true"]` (scoped to newest response).
  - `generation.thinking_dots`: `thinking-dots-animation` (document scoped).
  - `generation.pending_request` / `pending_response`: Transient generation wrappers.
  - `prompt.editor`: `input-area-v2 .ql-editor[contenteditable="true"]`.
  - `prompt.send_button`: `input-area-v2 button:has(mat-icon[data-mat-icon-name="arrow_upward"])`.
  - `grounding.source_chip`: `source-inline-chip`.

---

## 6. Milestone History & Architectural Evolution

| Date | Milestone / Version | Highlights | Suite Status |
|:---|:---|:---|:---:|
| 2026-09-21 | **v4.3.4 / v4.4.3** | Clean architecture; background WSS ownership; 8 MCP tools. | 95/95 Green |
| 2026-09-26 | **v4.4.3** | Chunk decoder fixes (`lmdx_content`), SDLC argument aliases. | 116 Green |
| 2026-09-29 | **v4.7.0 – v4.7.18** | Typed path establishment (KAN-182); Grounding verification; DOM signal contract. | 492 Green |
| 2026-10-01 | **v4.7.22 – v4.7.25** | Dual `/v1` & `/v2` API parity (KAN-234); Idle-based collection deadline & hard cap (KAN-236). | 629 Green |
| 2026-10-02 | **v4.7.28 – v4.7.32** | Two-way payload capture relay (`/debug/payload-capture`); classifier hardening. | 645 Green |
| 2026-10-04 | **v4.7.33** | Production baseline; recovered fixtures; latency & context analysis; payload shape contract. | 659 Tests (649 pass, 0 fail, 10 skip) |
| 2026-10-04 | **v4.7.34** | KAN-182 DO telemetry ring buffer (`/debug/telemetry`), `executeThroughExtension` timing telemetry, preflight disconnect capture, fixed `callGcpGemini` vlog interpolation. | **669 Tests (659 pass, 0 fail, 10 skip)** |

---

## 7. Deployment & CI/CD Governance

### 7.1 Single Authority: GitHub Actions CD (`.github/workflows/cd.yml`)
- Triggered on push to `main` affecting `cloudflare-worker/**` or `extension-cloudflare/**`.
- Gated by GitHub Environment `production` with required reviewers.
- Synchronizes secrets from Doppler (`gemini-web-bridge/prd_worker`) and deploys Worker `prod` using `npx wrangler deploy`.

### 7.2 Cloudflare Workers Builds Failure Analysis
- **Failure Cause**: Cloudflare Dashboard's automated Git integration ("Workers Builds: gemini-web-bridge") failed because the root directory lacks `package.json` and Doppler secrets, while also targeting an obsolete worker name.
- **Resolution**: Disable or disconnect automatic Git integration in Cloudflare Dashboard; GitHub Actions CD remains the sole authorized deployment pathway. See full runbook: [`docs/CLOUDFLARE-DASHBOARD-BUILDS-DISABLE.md`](docs/CLOUDFLARE-DASHBOARD-BUILDS-DISABLE.md).

---

## 8. Operational Runbook

### 8.1 Automated Test Execution
```bash
# Run complete test suite (669 tests, ~46s)
cd cloudflare-worker && npm test

# Run DOM contract checks
cd cloudflare-worker && node --test tests/dom-signals.test.mjs

# Run API version contract
cd cloudflare-worker && node --test tests/api_version_contract.test.mjs

# Run payload shape contracts
cd cloudflare-worker && node --test tests/payload-shape-contract.test.mjs

# Run telemetry endpoint contract (KAN-182)
cd cloudflare-worker && node --test tests/kan182-telemetry-endpoint.test.mjs

# Run production host invariant
cd cloudflare-worker && node --test tests/production-host.test.mjs
```

### 8.2 Live Verification Commands
```bash
# Health check (includes collection heartbeat and API versions)
curl -s https://prod.gemini-web-bridge.workers.dev/health | jq .

# Telemetry inspection (KAN-182 DO ring buffer, newest first)
curl -s https://prod.gemini-web-bridge.workers.dev/debug/telemetry \
  -H "Authorization: Bearer ${CLIENT_API_KEY}" | jq .

# Reset telemetry buffer before test runs
curl -s -X DELETE https://prod.gemini-web-bridge.workers.dev/debug/telemetry \
  -H "Authorization: Bearer ${CLIENT_API_KEY}" | jq .

# Verify MCP tools (lists 9 tools including horo_consult)
curl -s -X POST https://prod.gemini-web-bridge.workers.dev/mcp \
  -H "Authorization: Bearer ${CLIENT_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq .

# Test grounded BaZi consultation
curl -s -X POST https://prod.gemini-web-bridge.workers.dev/mcp \
  -H "Authorization: Bearer ${CLIENT_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":2,"method":"tools/call",
    "params":{
      "name":"horo_consult",
      "arguments":{
        "query":"วิเคราะห์ธาตุปรับดวงชะตา",
        "birth_context":{"day_master":"甲木","five_elements":"木2 火1 土3 金1 水1"}
      }
    }
  }' | jq .
```

### 8.3 Tool-Calling & Conversation Isolation Pattern
- **Session Isolation Rule**: When orchestrating multi-skill operations or delegating tasks, **different tool skills must execute in distinct, fresh conversation sessions**. Reusing a long-running conversation carrying previous task context causes context pollution and triggers latency degradation.
- **Default Arguments & Explicit Overrides**: Tools provide declared defaults (e.g. `horo_consult` defaults to `notebook:b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0`), but callers can explicitly pass custom scopes/prompts to override.

---

## 9. Security Guardrails Reference (G1–G5)

1. **G1 (Zero-Token-Leak)**: Google CSRF token (`SNlM0e`) stays in volatile RAM within the browser's MAIN world. Never leaves the local host.
2. **G2 (Strict Fail-Closed)**: No canned responses or mock responses. Offline extensions return HTTP 503; unverified groundings return JSON-RPC `-32000`.
3. **G3 (Concurrency & Quota Control)**: 1 execution per session, max 10 queued waiters, idle-based collection deadline with strict `hardCap`.
4. **G4 (Zero Technical Debt & 0 Fail Policy)**: All changes must maintain **0 failed tests** across the entire 694-test suite before pushing.
5. **G5 (Hybrid Transparency)**: GCP fallback emits `X-Provider: google-cloud-fallback` header; grounding-required requests are prohibited from falling back.

---

## 10. Forward Roadmap Status & Empirical Findings

1. **Sprint 1 (Alerting & Alarms)**: DO `alarm()` implemented for liveness and socket reaping. External webhook dispatcher (Discord/Slack) pending.
2. **Sprint 2 (Context & Memory & Latency)**:
   - **DO Telemetry Ring Buffer (`/debug/telemetry`)**: Implemented in KAN-182 (v4.7.34). Tracks `executeThroughExtension` latency, GCP fallback calls, and preflight disconnects with microsecond accuracy.
   - **Latency Failure Frontier (KAN-242)**: Live measurement via `/debug/telemetry` revealed clean turns average ~48–50s, but accumulated UI turns reach a hard failure frontier at 10 responses on screen (`no_answer_rendered`, timeout at 160s). This mandates automatic context rotation before conversations reach 10 turns. See full experimental plan: [`docs/verification/kan242-latency-measurement-plan.md`](docs/verification/kan242-latency-measurement-plan.md).
   - **Notebook Wire Format Divergence (KAN-236)**:
     - Horo notebook uses an 88-char opaque token at `[0][3][0][2]` (fingerprint `cff9779e`), stable across turns and conversations for that specific notebook.
     - Second notebook (`claude-code-best-practice`) uses a 46-char resource reference at `[19]` (`notebooks/<UUID>`, fingerprint `91296529`), with `contains.notebook_id = true`.
     - Direct worker-to-Google `StreamGenerate` calls cannot derive unknown notebook tokens/references without an empirical capture; UI typing remains the primary pathway for dynamic notebook sessions. See full investigation brief: [`docs/verification/kan236-notebook-token-stability-brief.md`](docs/verification/kan236-notebook-token-stability-brief.md).
3. **Sprint 3 (Multi-Session Balancing & Infrastructure)**:
   - `ScopeRouter` envelope routing complete within DO.
   - **Cloudflare Dashboard Builds Integration**: Root lacks `package.json` and Doppler secrets; human one-time disconnect in Cloudflare Dashboard is required (see [`docs/CLOUDFLARE-DASHBOARD-BUILDS-DISABLE.md`](docs/CLOUDFLARE-DASHBOARD-BUILDS-DISABLE.md)). GitHub Actions `cd.yml` remains the sole authorized deployment pathway.
   - Cross-instance multi-account load balancing remains on the future roadmap.

## Addendum 2026-10-04 (Orchestrator & Blue Team)
- **KAN-242 (Automatic Conversation Context Rotation)**: **100% COMPLETE & VERIFIED** across full 3-day architecture.
  - Extension probe (`CONVERSATION_STATS`) + Worker DO headroom guard (`ensureConversationHeadroom`).
  - Flag ships ON (`CONTEXT_ROTATION_THRESHOLD = "8"` in `wrangler.toml`).
  - Wire order invariant strictly preserved: context rotation (`prepareScope("app")`) runs BEFORE notebook attach (`ATTACH_NOTEBOOK`).
  - Guardrails fully verified: pinned scopes (`app:<id>`, `notebook:<id>`) skipped with telemetry; in-flight protection; fail-open probe fallback; G1 zero prompt/response leak in telemetry.
- **T4 (`horo_consult` scope default)**: Scope handling aligned (`HORO_CONSULT_DEFAULT_SCOPE` defaults cleanly to in-place attachment without triggering raw URL routing).
- **Test Suite Baseline**: **694 tests (684 passed, 0 failed, 10 skipped)**. Full 100% Green Phase.
- **Git & Deployment Status**:
  - Committed in `ed6c337` (`KAN-242: implement automatic conversation context rotation and horo_consult default scope (KAN-255)`)
  - Build hardening committed in `a63e1b9` (`KAN-242: fix(build): add dotenv fallback for local extension packaging`)
  - Both commits pushed and synchronized with `origin/main`.
- See detailed log in [`SESSION_HANDOFF-2026-10-04.md`](SESSION_HANDOFF-2026-10-04.md).
