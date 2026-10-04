# KAN-242: Latency vs. Conversation-Context Measurement Plan

**Document Version:** 1.0.0  
**Target Milestone:** KAN-242 (Latency scaling & typed path longevity)  
**System Baseline:** gemini-web-bridge v4.7.34 (Cloudflare Worker DO + Chrome Extension)  
**Date:** 2026-10-04  
**Author:** agy2 (Autonomous Agent)

---

## 1. Executive Summary & Purpose

The goal of KAN-242 is to determine whether request latency scales with conversation length when answer length is strictly controlled, and specifically to evaluate whether the typed execution path (`typePromptThroughUi` + `collectTypedAnswer`) degrades or times out as turns accumulate in a conversation session.

Prior attempts in KAN-236 (documented in [`docs/verification/kan236-latency-vs-context-2026-10-02.md`](file:///Users/kimlenglim/Project/gemini-web-bridge/docs/verification/kan236-latency-vs-context-2026-10-02.md) and [`docs/HANDOVER-2026-10-02.md`](file:///Users/kimlenglim/Project/gemini-web-bridge/docs/HANDOVER-2026-10-02.md) §4c) were blocked by browser tooling constraints:
1. DevTools/Kapture network request buffers overflowed with high-frequency Google analytics beacons (~3 requests/sec), masking `StreamGenerate` calls.
2. DOM polling of `model-response` was interval-censored (~3 s granularity) and prohibitive in token budget (~4 tool calls/turn).
3. Production Workers observability was disabled to preserve CPU limits, and `wrangler tail` could not observe Durable Object (DO) console logs.

With **KAN-182** shipped in v4.7.34, the Durable Object now maintains an in-memory telemetry ring buffer recording exact server-side execution durations (`durationMs`), outcomes, and message counts, queried directly via the authenticated `GET /debug/telemetry` endpoint.

This document defines a concrete, repeatable, end-to-end measurement plan for KAN-242 leveraging this new telemetry infrastructure.

---

## 2. KAN-182 Telemetry Infrastructure Specification

### 2.1 Architecture & Ring Buffer Constraints
- **Location:** In-memory array on the Durable Object instance (`this.telemetryBuffer`).
- **Capacity:** Fixed ring buffer capped at `TELEMETRY_BUFFER_MAX = 50` entries (`cloudflare-worker/src/index.js` line 59).
- **Eviction Policy:** FIFO eviction; when the 51st entry is pushed, `this.telemetryBuffer.shift()` drops the oldest entry.
- **Ordering:**
  - Internal storage: Oldest first (`push`).
  - `GET /debug/telemetry`: Reversed, returning **newest first**.
- **Privacy & Sanitization Contract:** Zero prompt or response body text is ever recorded. Telemetry contains strictly operational metadata (timestamps, durations, counts, outcomes, error messages).

### 2.2 Telemetry Entry Schema (Exact Contract)

Every entry stamped by `recordTelemetry(entry)` receives an automatic millisecond epoch timestamp `ts`:

```typescript
interface BaseTelemetryEntry {
  ts: number;                 // Epoch milliseconds (Date.now())
  kind: "executeThroughExtension" | "callGcpGemini" | "preflight" | string;
  outcome: "ok" | "error";
  durationMs?: number;        // Elapsed time in ms (omitted on preflight)
  messages?: number;          // Array length of messages
  error?: string;             // Error message (present when outcome === "error")
}
```

#### Exact Entry Variants

1. **`executeThroughExtension` Success:**
   ```json
   {
     "ts": 1791084200123,
     "kind": "executeThroughExtension",
     "durationMs": 4125,
     "messages": 5,
     "outcome": "ok"
   }
   ```
   *Recorded at:* `cloudflare-worker/src/index.js` line 2007 (single success exit after reply verdict classification).

2. **`executeThroughExtension` Failure:**
   ```json
   {
     "ts": 1791084205500,
     "kind": "executeThroughExtension",
     "durationMs": 120015,
     "messages": 5,
     "outcome": "error",
     "error": "The prompt was submitted but no new answer was rendered for it..."
   }
   ```
   *Recorded at:* `cloudflare-worker/src/index.js` line 1808 (inside `failWith(err)` handler covering disconnects, typing failures, collection timeouts, and rejected payloads).

3. **`callGcpGemini` Success / Failure:**
   ```json
   {
     "ts": 1791084210000,
     "kind": "callGcpGemini",
     "durationMs": 850,
     "messages": 1,
     "outcome": "ok"
   }
   ```
   *Recorded at:* lines 1789 (success) and 1792 (error).

4. **`preflight` Fail-Fast Disconnect:**
   ```json
   {
     "ts": 1791084215000,
     "kind": "preflight",
     "outcome": "error",
     "error": "extension disconnected",
     "messages": 3
   }
   ```
   *Recorded at:* line 3081 (`/v1/chat/completions` preflight) and line 3973 (`horo_consult` preflight).

### 2.3 API Endpoints & Auth Gate

The `/debug/telemetry` endpoint is protected by the same generic authentication gate as `/debug/payload-capture` (`Authorization: Bearer <CLIENT_API_KEY>`). It is **not** in `publicPaths`, returning HTTP `401 Unauthorized` without credentials.

| Method | Path | Description | Response Shape |
|---|---|---|---|
| `GET` | `/debug/telemetry` | Retrieves buffer (newest first) | `{"ok": true, "count": N, "entries": [...]}` |
| `DELETE` | `/debug/telemetry` | Clears ring buffer | `{"ok": true, "cleared": true, "count": 0, "entries": []}` |

---

## 3. How KAN-182 Unblocks KAN-242 (Resolution of HANDOVER §4c)

In `docs/HANDOVER-2026-10-02.md` §4c, the controlled latency measurement was abandoned due to structural tooling blocks. The following matrix shows how KAN-182 resolves each blocker:

| Legacy Blocker (2026-10-02) | Legacy Failure Mode | KAN-182 Unblocking Mechanism |
|---|---|---|
| **Kapture network monitor flooding** | 566 requests/session; ~3 analytics calls/sec (`play.google.com/log`). Extracting `StreamGenerate` was token-prohibitive. | **Eliminated.** Zero browser network monitoring required. Timing is measured directly inside the DO from socket dispatch to stream completion. |
| **Out-of-band completion blindness** | `COLLECT_ANSWER_PROGRESS` and `/health` `last_successful_generation` only advanced for bridge-orchestrated turns, staying `null` for external Kapture sends. | **Resolved.** Turns are driven directly through the bridge API (`/v1/chat/completions` or MCP `horo_consult`), ensuring every turn exercises the instrumented bridge path. |
| **DOM polling interval censoring** | Polling `model-response` every ~3 s introduced artificial 0–3 s measurement jitter and fixed delay floors. | **Resolved.** Server-side timer (`Date.now() - startTime`) records duration with 1 ms precision upon final chunk / text settlement. |
| **Blind DO logging in production** | `wrangler tail` does not surface DO logs; Workers Logs observability was disabled to protect CPU limits. | **Resolved.** In-memory telemetry ring buffer stores the last 50 outcomes. Data is retrieved cleanly via HTTP `GET /debug/telemetry`. |

---

## 4. Experimental Design & Measurement Protocol

### 4.1 Research Questions
1. **Latency Scaling:** Does `executeThroughExtension` duration scale monotonically with prior conversation history when output length is held constant?
2. **Longevity & Failure Frontier:** Does the typed path fail or trigger a `collect_answer_timeout` (120 s) at a specific turn threshold (e.g. 5, 10, or 15 accumulated turns)?
3. **Backend vs. Client Attribution:** Does latency increase correlate with the RPC context block (`f.req[3]`) or DOM transcript size?

### 4.2 Control Variables & Isolation Controls

| Variable | Control Mechanism | Target Value / Constraint |
|---|---|---|
| **Answer Length** | Fixed-output prompt instruction | Output strictly 16 characters (`"7"` or standard Thai token) |
| **Prompt Length** | Pinned probe prompt | Constant 58-character probe prompt |
| **Tab Visibility** | Foreground active window | Tab visible, non-minimized, focus maintained (prevents Chrome timer throttling) |
| **Execution Path** | Bridge typed path vs replay | Consistent routing (`requireTypedPath=true` for DOM typed path) |
| **Model & Build** | Version verification | Model held constant (`Flash` / `gemini-3.8-flash-lite`); build label recorded from `/health` |

#### Pinned Fixed-Output Probe Prompt
```text
Output exactly 7. No punctuation, citation, or other text.
```
*Expected answer:* `7` (rendered as 16 JavaScript chars in Gemini DOM envelope).

#### History Accumulator (Context Inflation)
To scale context between measurement probes, inject standardized neutral text blocks (e.g., 5,000–10,000 character neutral encyclopedic excerpts) or sequential multi-turn dialogue.

### 4.3 Dual Context Length Metrics

A critical finding from KAN-236 is that **visible rendered characters do NOT equal model context size**, and `f.req[3]` does not scale 1:1 with rendered text. KAN-242 must record both:

1. **Tier 1: Cumulative Rendered Transcript Length (DOM Proxy)**
   - Measured via DOM query: total `innerText.length` of all preceding `user-query` and `model-response` elements.
   - Measures browser rendering load and client memory consumption.

2. **Tier 2: Actual Wire `StreamGenerate` RPC Context Block (`f.req[3]`)**
   - Arm `/debug/payload-capture` (`POST /debug/payload-capture {"armed": true}`).
   - Extract `record.structure[3].length` (or `structure[3].items` byte size).
   - This represents the exact token/context state transmitted to Google servers.

3. **Tier 3: Discrete Turn Count**
   - Number of prior user/assistant turns in the conversation thread (0, 1, 2, ..., N).

### 4.4 Sample Size & Statistical Power
- **Per-Conversation Progression:** 10 consecutive turns in a single conversation thread.
- **Replications:** 3 independent fresh conversations (Threads A, B, C).
- **Total Sample Size:** $N = 30$ measurement points.
- **Statistical Analysis:**
  - Compute Pearson correlation coefficient ($r$) and Spearman rank correlation ($\rho$) between:
    - Prior Turn Count vs. `durationMs`
    - Cumulative Rendered Chars vs. `durationMs`
    - Wire Context Size (`f.req[3]`) vs. `durationMs`
  - Regression slope ($ms / 1,000\text{ chars}$) to quantify latency penalty.
  - Identification of inflection points or timeouts ($> 120,000\text{ ms}$).

---

## 5. Step-by-Step Execution Runbook

### Phase 1: Environment & Pre-Flight Verification
1. Ensure Google Chrome has an active, authenticated `gemini.google.com` tab in the foreground.
2. Verify Worker health:
   ```bash
   curl -s https://prod.gemini-web-bridge.workers.dev/health | jq '{version, extension_status, consecutive_errors: .health_metrics.consecutive_errors}'
   ```
   *Requirement:* `extension_status == "CONNECTED_AND_READY"`, `version == "4.7.34"`.
3. Obtain API key:
   ```bash
   KEY=$(doppler secrets get CLIENT_API_KEY --project gemini-web-bridge --config prd --plain | tr -d '\n\r')
   BASE="https://prod.gemini-web-bridge.workers.dev"
   ```

### Phase 2: Instrumentation Arming
1. Reset telemetry buffer:
   ```bash
   curl -s -X DELETE "$BASE/debug/telemetry" \
     -H "Authorization: Bearer $KEY" | jq .
   ```
   *Expected:* `{"ok": true, "cleared": true, "count": 0, "entries": []}`.

2. Arm payload capture to monitor `f.req[3]` context block:
   ```bash
   curl -s -X POST "$BASE/debug/payload-capture" \
     -H "Authorization: Bearer $KEY" \
     -H "Content-Type: application/json" \
     -d '{"armed": true}' | jq .
   ```
   *Expected:* `{"armed": true, ...}`.

### Phase 3: Controlled Measurement Loop (Automated Script)

For each target turn $i \in \{1 \dots 10\}$:

1. **Send Pinned Probe Prompt via `/v1/chat/completions`:**
   ```bash
   curl -s -X POST "$BASE/v1/chat/completions" \
     -H "Authorization: Bearer $KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "model": "gemini-3.8-flash",
       "messages": [
         {"role": "user", "content": "Output exactly 7. No punctuation, citation, or other text."}
       ]
     }' | jq -r '.choices[0].message.content'
   ```

2. **Harvest Server Telemetry:**
   ```bash
   curl -s "$BASE/debug/telemetry" \
     -H "Authorization: Bearer $KEY" | jq '.entries[0]'
   ```
   *Extract:* `durationMs`, `messages`, `outcome`, `ts`.

3. **Harvest Payload Wire Context:**
   ```bash
   curl -s "$BASE/debug/payload-capture" \
     -H "Authorization: Bearer $KEY" | jq '.captures[-1] | {at, extensionVersion, context_len: .record.structure[3].length}'
   ```

4. **Inject History Increment (Turns 2–10):**
   Send a context expander prompt to inflate the conversation history before the next probe.

### Phase 4: Teardown & Disarming
Always disarm payload capture after the test run:
```bash
curl -s -X POST "$BASE/debug/payload-capture" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"armed": false}'
```

---

## 6. Data Collection Matrix (Template)

| Turn | Conversation ID | Visible Rendered Chars | Wire `[3]` Chars | Answer Chars | Telemetry `durationMs` | Outcome | Notes / Anomalies |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---|
| 1 | `conv_A` | 0 | 2,672 | 16 | 3,420 | ok | Baseline fresh turn |
| 2 | `conv_A` | 5,200 | 2,680 | 16 | 3,550 | ok | +5k chars seed |
| 3 | `conv_A` | 10,400 | 2,680 | 16 | 3,610 | ok | +5k chars seed |
| 4 | `conv_A` | 20,800 | 2,685 | 16 | 3,890 | ok | +10k chars seed |
| 5 | `conv_A` | 35,000 | 2,685 | 16 | 4,120 | ok | +15k chars seed |
| 6 | `conv_A` | 50,000 | 1,705 | 16 | 4,450 | ok | Context reorganization |
| 7 | `conv_A` | 70,000 | 1,705 | 16 | 4,680 | ok | Long conversation |
| 8 | `conv_A` | 90,000 | 1,705 | 16 | 4,920 | ok | Extreme length |
| 9 | `conv_A` | 110,000 | 1,705 | 16 | 5,150 | ok | Approaching limits |
| 10 | `conv_A` | 130,000 | 1,705 | 16 | 5,400 | ok | Final target probe |

---

## 7. Fast-Check Diagnostic Commands

Quick-reference commands for operators and agents running the verification:

```bash
# 1. Quick check current telemetry buffer (newest first)
curl -s "https://prod.gemini-web-bridge.workers.dev/debug/telemetry" \
  -H "Authorization: Bearer $KEY" | jq '{count, entries: [.entries[] | {kind, outcome, durationMs, messages, error}]}'

# 2. Reset telemetry buffer before test run
curl -s -X DELETE "https://prod.gemini-web-bridge.workers.dev/debug/telemetry" \
  -H "Authorization: Bearer $KEY" | jq .

# 3. Check health and extension connection status
curl -s "https://prod.gemini-web-bridge.workers.dev/health" | jq '{version, extension_status, health_metrics}'
```
