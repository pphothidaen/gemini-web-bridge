# KAN-236: Notebook Token Stability Investigation Brief

**Document:** `docs/verification/kan236-notebook-token-stability-brief.md`  
**Date:** 2026-10-04  
**Author / Investigator:** agy3 (Subagent)  
**Status:** Complete — Ready for Operator Verification  

---

## 1. Executive Summary & Core Verdict

The direct Cloudflare Worker $\to$ Gemini `StreamGenerate` bypass path (KAN-236) depends on whether notebook bindings can be reproduced directly on the wire without DOM-based typing and chip attachment.

- **For the known Horo notebook (`b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0`):**
  The notebook binding consistently manifests at **`[0][3][0][2]`** as an **88-character opaque token** (alphanumeric `lower+upper+digit`, fingerprint `cff9779e`). This token is proven **stable across turns in the same conversation** and **stable across two different conversations**.
- **For a second notebook (`claude-code-best-practice`, 56 sources):**
  A live capture taken on 2026-10-03 revealed that the 88-character field at `[0][3][0][2]` was **absent**. Instead, the sanitized record exposed a **46-character string at top-level field `[19]`** with fingerprint `91296529` and `contains.notebook_id: true`.
- **Core Stability Question:**
  *Does the 88-character token vary per notebook, or is it an account/session/universal token?*
- **Verdict:**
  **NOT ANSWERABLE from existing repository data.** Because the second notebook produced a completely different payload shape (a 46-char resource reference at `[19]` rather than an 88-char token at `[0][3]`), there is no second 88-character token to compare against Horo's `cff9779e`. Stability across turns for the second notebook is also unmeasured (only one capture exists). **Exactly one controlled capture is required to settle this question.**

---

## 2. Comprehensive Capture Record

Across the repository and historical logs, **8 captures** have been documented (7 sanitized captures pinned in fixtures and regression tests, plus 1 live second-notebook capture from 2026-10-03):

| Capture ID / Label | Source | Date | Notebook Attached | Extension Version | `hasEnvelope` | `[0][3]` Present? | Token Index & Length | Fingerprint | Field `[19]` Shape |
|---|---|---|---|---|---|---|---|---|---|
| **Sample A** | `docs/payload-samples/` | 2026-09-29 | Horo (grounded) | pre-4.7.28 | `true` | **Yes** | `[0][3][0][2]`: 88 | N/A (legacy) | `null` |
| **Sample B** | `docs/payload-samples/` | 2026-09-29 | Horo (ungrounded) | pre-4.7.28 | `true` | **Yes** | `[0][3][0][2]`: 88 | N/A (legacy) | `null` |
| **app-ungrounded-01** | `streamgenerate-captures.json` | 2026-10-01 | None (plain `/app`) | pre-4.7.32 | `true` (inherited) | **No** | None | N/A | `{"kind":"string", "length":46, "cls":"opaque"}` |
| **app-chip-present-2026-10-02** | `streamgenerate-captures.json` | 2026-10-02 | Horo (grounded) | pre-4.7.32 | `true` (inherited) | **Yes** | `[0][3][0][2]`: 88 | `cff9779e` | `null` |
| **app-chip-present-2026-10-02b** | `streamgenerate-captures.json` | 2026-10-02 | Horo (grounded) | `4.7.32` | `true` (inherited) | **Yes** | `[0][3][0][2]`: 88 | `cff9779e` | `null` |
| **app-chip-repeat-2026-10-02** | `streamgenerate-captures.json` | 2026-10-02 | Horo (repeat turn) | `4.7.32` | `true` (inherited) | **Yes** | `[0][3][0][2]`: 88 | `cff9779e` | `null` |
| **app-chip-absent-2026-10-02** | `streamgenerate-captures.json` | 2026-10-02 | None (plain `/app`) | `4.7.32` | `true` (inherited) | **No** | None | N/A | `null` |
| **claude-code-best-practice** | Live 2026-10-03 capture | 2026-10-03 | Claude Code (56 sources) | `4.7.33` | `true` | **No** | None at `[0][3]` | N/A | `{"kind":"string", "length":46, "cls":"opaque"}`, `contains.notebook_id: true`, fp: `91296529` |

### Key Observations:
1. **The 20-Field Wire Invariant:** Every captured `StreamGenerate` request carries 20 top-level fields (contrasting with the Cloudflare Worker builder's original 10-to-12 fields).
2. **Chip Attachment vs. Grounding Verification:** Sample B was response-ungrounded (0 citations), but `[0][3]` was present. Chip attachment is an invariant of the *request wire format*, whereas citation verification is a property of the *model's response*.
3. **Producer Extension Version Integrity:** Captures `app-chip-present-2026-10-02b`, `repeat`, and `absent` self-report `extensionVersion: "4.7.32"`, confirming that the substring classifier fix (`notebook(s)://`) was active.

---

## 3. Dissecting the Divergence: Horo (`[0][3]`) vs Second Notebook (`[19]`)

### 3.1 Horo Notebook Binding (`[0][3]`)
For the Horo notebook, attaching the notebook chip in `/app` produces a branch at `[0][3]`:
```json
[0][3]: [
  [
    [ null, <number>, <number>, { "kind": "string", "length": 0, "cls": "opaque" } ],
    { "kind": "string", "length": 4, "cls": "opaque" },
    { "kind": "string", "length": 88, "cls": "opaque", "fingerprint": "cff9779e" }
  ]
]
```
- **Charset:** `[a-zA-Z0-9]` (no dashes, slashes, or colons).
- **Fingerprint:** `cff9779e` (stable across turns and across distinct conversations with differing conversation IDs `09b7b2e5` vs `ac1eae62`).
- **Field `[19]`:** Strictly `null`.

### 3.2 Second Notebook Binding (`[19]`)
For `claude-code-best-practice`, the capture showed:
- `[0][3]`: **Absent** (`null`).
- `[19]`: An opaque string of length **46**, fingerprint `91296529`.
- **`contains.notebook_id`:** `true`.

### 3.3 Why Field `[19]` is 46 Characters
A canonical Google notebook UUID is 36 characters (e.g., `b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0`).
The resource scheme prefix `notebooks/` is exactly 10 characters:
$$\text{length}(\texttt{"notebooks/"}) + \text{length}(\text{UUID}) = 10 + 36 = 46$$
Because `injected.js` checks `str.includes(NOTEBOOK_ID_HINT)`, where the hint is the 36-char UUID, `contains.notebook_id` returned `true`.

### 3.4 Why Did the Shape Differ?
Three plausible explanations exist:
1. **Attachment Mechanism / Surface Difference:** Horo was attached via the `/app` editor chip flow (`+ > more uploads > Notebooks > เพิ่ม Notebook`). If the second notebook was opened directly from `/notebook/<id>` or referenced differently, the client sends `notebooks/<uuid>` at field `[19]` rather than generating an opaque session token at `[0][3]`.
2. **Backend Server Build Rollout:** Horo was captured under UI server builds `boq_assistant-bard-web-server_20260929` and `boq_gemini-web-uiserver_20261001.01_p0`. The second notebook was captured under `boq_gemini-web-uiserver_20261002.02_p0`. Google may have shifted notebook transport from `[0][3]` to top-level `[19]`.
3. **Notebook Size / Indexing Differences:** Horo has 1 BaZi reference document, whereas `claude-code-best-practice` has 56 sources. Large/multi-source notebooks might use a direct resource handle (`[19]`) instead of an in-memory embedding context token (`[0][3]`).

---

## 4. Why the Stability Question Remains Open

To prove token stability across notebooks:
1. We must observe **two different notebooks** emitting the **same structural field**.
2. If `[0][3][0][2]` is the standard chip attachment token, we must see whether Notebook B produces an 88-character token whose fingerprint is **different** from `cff9779e` (proving per-notebook identity) or **identical** to `cff9779e` (proving a session/account token).
3. If `[19]` is the new or alternative standard, we need a second turn on Notebook B to verify stability across turns, and a re-capture of Horo under the same build to see if Horo also emits `[19]`.

None of this is observable from current data because:
- We have no second notebook emitting `[0][3]`.
- We have only one capture emitting `[19]`.

---

## 5. The Single Capture Needed

### Target Objective
Obtain **one live `StreamGenerate` capture** of a second notebook (`claude-code-best-practice` or any second non-Horo notebook) attached via the **standard `/app` in-place chip attachment dialog**, under the current extension version (`4.7.34+`).

### Prerequisites
- Chrome browser with Gemini Web Bridge extension reloaded and active.
- Gemini `/app` tab open in foreground.
- Doppler CLI with access to `gemini-web-bridge` `prd` credentials.

### Critical Operational Warnings
> [!WARNING]
> **`horo_consult` Consumes Attachment Per-Message:**  
> The Gemini chat interface consumes the attached notebook chip upon sending. Any subsequent message in that conversation will be ungrounded unless re-attached. Always use a **fresh `/app` conversation** for each test capture.

> [!IMPORTANT]
> **Navigation Resets Page-Side Capture State:**  
> The `payloadCaptureArmed` state lives inside the page script context (`injected.js`). Navigating to `/app` or switching URLs **resets the arm state to false**. Always navigate to the target conversation and attach the chip **BEFORE** arming the relay.

---

## 6. Step-by-Step Operator Capture Procedure

Execute this exact sequence from terminal:

### Step 1: Retrieve Credentials
```bash
KEY=$(doppler secrets get CLIENT_API_KEY --project gemini-web-bridge --config prd --plain | tr -d '\n\r')
BASE="https://prod.gemini-web-bridge.workers.dev/debug/payload-capture"
```

### Step 2: Prepare Gemini Tab (Browser)
1. Open a **fresh** `/app` conversation at `https://gemini.google.com/app`.
2. Attach the second notebook chip via the UI:  
   Click `+` $\to$ `Notebooks` $\to$ select `claude-code-best-practice`.
3. Confirm the notebook chip appears in the prompt textarea.
4. **Do not send yet.**

### Step 3: Arm Payload Capture with Scope Hint (Terminal)
Arm the relay, passing the second notebook's UUID scope so `contains.notebook_id` can be verified automatically:
```bash
# Replace <uuid> with the notebook UUID (e.g. for claude-code-best-practice)
curl -s -X POST "$BASE" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"armed": true, "scope": "notebook:<second-notebook-uuid>"}'
```
*Expected response:* `{"armed":true,"max":3,"cleared":true}`

### Step 4: Send the Prompt (Browser)
1. In the prepared Gemini tab, type a prompt that requires notebook context (e.g., `Summarize the key architectural principles`).
2. Press **Send**.
3. Wait for the response to finish streaming and settle.

### Step 5: Read and Inspect Captured Structure (Terminal)
```bash
curl -s "$BASE?cb=$RANDOM" -H "Authorization: Bearer $KEY" | jq .
```
Filter specifically for the `StreamGenerate` record:
```bash
curl -s "$BASE?cb=$RANDOM" -H "Authorization: Bearer $KEY" | jq '
  .captures[].record
  | select(.structure.hasEnvelope == true)
  | {
      endpoint,
      extensionVersion,
      topLevelFields: (.structure.structure | length),
      chipBranch_0_3: .structure.structure[0][3],
      field_19: .structure.structure[19]
    }'
```

### Step 6: Disarm the Relay Immediately (Terminal)
```bash
curl -s -X POST "$BASE" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"armed": false}'
```
*Expected response:* `{"armed":false,"max":3,"cleared":false}`

---

## 7. Current Relay Armed Status Check

- **Local environment check:** `/Users/kimlenglim/.env` is **not present** on disk.
- **Handoff status verification:** Per `docs/HANDOVER-2026-10-02.md`, `docs/NEXT-STEPS.md`, and `docs/SESSION_HANDOFF-2026-10-04.md`:
  - Production payload capture was explicitly disarmed after all test runs.
  - The Durable Object default initialization has `payloadCaptureArmed = false`.
  - Expected state: **DISARMED** (safe, unmonitored default state).
