# 🧭 Master Project Handoff & Planning Roadmap

> **Gemini Web Bridge (Edge AI Gateway & Hybrid Hub)**  
> **Current Version:** v4.2.1-hybrid (`5da34b8`)  
> **Status:** Production Deployed & 100% Operational  
> **Production Endpoint:** `https://gemini-web-bridge.taijustarrett417.workers.dev`  
> **Last Verified:** 2026-09-15 | **Test Pass Rate:** 69 / 69 Tests (100% GREEN)  

---

## 📑 สารบัญ (Table of Contents)

1. [สรุปสถานะปัจจุบัน (Current Baseline)](#1-สรุปสถานะปัจจุบัน-current-baseline)
2. [งานที่ดำเนินการแล้วเสร็จ (Completed Milestones)](#2-งานที่ดำเนินการแล้วเสร็จ-completed-milestones)
3. [แผนงานระยะต่อไป (Forward Planning Roadmap)](#3-แผนงานระยะต่อไป-forward-planning-roadmap)
   * [Sprint 1: Proactive Alerting & Health Automation](#sprint-1-proactive-alerting--health-automation-short-term)
   * [Sprint 2: Context Persistence & Vector Memory](#sprint-2-context-persistence--vector-memory-mid-term)
   * [Sprint 3: Multi-Session Load Balancing](#sprint-3-multi-session-load-balancing-long-term)
4. [คู่มือการปฏิบัติงาน (Operational Runbook)](#4-คู่มือการปฏิบัติงาน-operational-runbook)
5. [ตาราง Environment Secrets & Configurations](#5-ตาราง-environment-secrets--configurations)
6. [กฎเหล็กและข้อบังคับ (Guardrails Reference)](#6-กฎเหล็กและข้อบังคับ-guardrails-reference)

---

## 1. สรุปสถานะปัจจุบัน (Current Baseline)

### 1.1 โครงสร้างสถาปัตยกรรม (High-Level Architecture)

```text
┌────────────────────────────────────────────────────────────────────────┐
│                         AI Clients (HTTPS)                             │
│       Hermes Agent · Cursor · Cline · Claude Code · Python SDK         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Authorization: Bearer <CLIENT_API_TOKEN>
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│             Cloudflare Worker (gemini-web-bridge Edge Hub)             │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                 GeminiBridgeDO (Durable Object)                │   │
│   │   • FIFO Queue (Max 10 Waiters, 60s Execution Deadline)        │   │
│   │   • Dynamic Model Catalog (Browser Synchronized & Verified)    │   │
│   │   • Remote MCP Server (7 SDLC & Diagnostic Tools)              │   │
│   │   • Health State Tracker (Consecutive Errors, Last Success)    │   │
│   └─────────────────┬──────────────────────────────┬───────────────┘   │
│                     │                              │                   │
│                     │ WebSocket (WSS Protocol v2)   │ Fallback (Failover)
│                     ▼                              ▼                   │
│   ┌──────────────────────────────────┐   ┌───────────────────────────┐ │
│   │ Chrome Extension (gemini.google) │   │ Google Cloud Platform     │ │
│   │ • background.js (Tab Coordinator)│   │ • Vertex AI / Gemini API  │ │
│   │ • content.js (Isolated World)    │   │ • Header:                 │ │
│   │ • injected.js (MAIN World CSRF)  │   │   X-Provider: gcp-fallback│ │
│   └──────────────────────────────────┘   └───────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

### 1.2 สถานะความพร้อมของระบบ (System Health Check)

* **Endpoints ในระดับ Production:**
  * Status Dashboard: `GET https://gemini-web-bridge.taijustarrett417.workers.dev/health` (HTTP 200 OK)
  * OpenAI REST API: `POST https://gemini-web-bridge.taijustarrett417.workers.dev/v1/chat/completions` (Response < 3s)
  * Model Catalog: `GET https://gemini-web-bridge.taijustarrett417.workers.dev/v1/models` (7 Discovered, 4 Verified)
  * Remote MCP Server: `POST https://gemini-web-bridge.taijustarrett417.workers.dev/mcp` (7 Tools Live)
  * Chrome WebSocket Bridge: `wss://gemini-web-bridge.taijustarrett417.workers.dev/bridge` (CONNECTED_AND_READY)
* **ความสมบูรณ์ของโค้ด:** 0 `TODO`, 0 `FIXME`, 0 `HACK`, 0 `BLOCKER` ใน Source Code ทั้งหมด

---

## 2. งานที่ดำเนินการแล้วเสร็จ (Completed Milestones)

| วันที่ | Milestone | รายละเอียดการดำเนินการ | Commit |
|:---|:---|:---|:---:|
| 2026-09-15 | **Technical Debt Settlement** | ลบโฟลเดอร์ Legacy `proxy/` ทั้งหมด (1,679 บรรทัด) และแก้ไข Hardcoded Build Label ใน `injected.js` เป็น Fail-Fast | [`e2ab850`](file:///Users/kimlenglim/Project/gemini-web-bridge/extension-cloudflare/injected.js) |
| 2026-09-15 | **Roadmap Planning & Handoff** | จัดทำเอกสาร [PLANNING-HANDOFF.md](file:///Users/kimlenglim/Project/gemini-web-bridge/PLANNING-HANDOFF.md) วางสเปกและขั้นตอนการทำงาน 3 หัวข้อ | [`7c9758c`](file:///Users/kimlenglim/Project/gemini-web-bridge/PLANNING-HANDOFF.md) |
| 2026-09-15 | **Architectural Guardrails** | วางกฎเหล็ก [GUARDRAILS.md](file:///Users/kimlenglim/Project/gemini-web-bridge/GUARDRAILS.md) 5 เสาหลัก (G1: Token Privacy, G2: No Fabrication, G3: State Isolation, G4: Regression Gates, G5: Hybrid Governance) | [`88332d5`](file:///Users/kimlenglim/Project/gemini-web-bridge/GUARDRAILS.md) |
| 2026-09-15 | **MCP Tools & GCP Fallback** | เพิ่มเครื่องมือ `check_bridge_health`, `list_bridge_models`, ปรับปรุง `ping`, และพัฒนาระบบ GCP Hybrid Fallback (`callGcpGemini`) | [`b5b1a21`](file:///Users/kimlenglim/Project/gemini-web-bridge/cloudflare-worker/src/index.js) |
| 2026-09-15 | **Red Team ⚔️ Blue Team TDD** | สร้างชุดทดสอบ Adversarial [`red-team-adversarial.test.mjs`](file:///Users/kimlenglim/Project/gemini-web-bridge/cloudflare-worker/tests/red-team-adversarial.test.mjs) และแก้ Test Harness ให้ผ่าน **69 / 69 Tests 100%** | [`5da34b8`](file:///Users/kimlenglim/Project/gemini-web-bridge/cloudflare-worker/tests/red-team-adversarial.test.mjs) |
| 2026-09-15 | **Production Deployment** | Git Push ขึ้น `origin` และ `fork`, Deploy ขึ้น Cloudflare Workers Production และทดสอบ Live E2E สำเร็จ | [`5da34b8`](file:///Users/kimlenglim/Project/gemini-web-bridge/) |

---

## 3. แผนงานระยะต่อไป (Forward Planning Roadmap)

ตารางลำดับความสำคัญของงานที่สามารถดำเนินการต่อได้ในอนาคต:

```mermaid
flowchart TD
    Current["✅ v4.2.1-hybrid (Current Live)"]
    S1["Sprint 1: Proactive Alerting<br/>(Discord/Slack + Health Alarms)"]
    S2["Sprint 2: Vector Memory<br/>(D1 Context + Vertex AI Embeddings)"]
    S3["Sprint 3: Multi-Session<br/>(BridgeRouterDO + Multi-Tab)"]

    Current --> S1
    S1 --> S2
    S2 --> S3

    style Current fill:#bfb,stroke:#333,stroke-width:2px
    style S1 fill:#bbf,stroke:#333,stroke-width:2px
    style S2 fill:#f9f,stroke:#333,stroke-width:2px
    style S3 fill:#eee,stroke:#333,stroke-width:1px
```

---

### 🟢 Sprint 1: Proactive Alerting & Health Automation (Short-Term)

* **เป้าหมาย:** แจ้งเตือนผู้ดูแลระบบอัตโนมัติเมื่อ Session เบราว์เซอร์หลุด หรือเกิด Error สะสม
* **ความยาก:** ต่ำ (1-2 วัน) | **ความคุ้มค่า:** สูงมาก (High Reliability)

#### Tasks ย่อย:
1. **Epic 1.1 — Webhook Notification Dispatcher**
   * กำหนดค่า `WEBHOOK_URL` ใน `wrangler.toml` (Wrangler Secret)
   * เพิ่ม Cloudflare Durable Object Alarm (`alarm()`) หรือ Cron Trigger ตรวจสุขภาพทุก 5 นาที
   * หาก `consecutiveErrors >= 3` หรือ Extension หลุด ให้ยิง Webhook แจ้งเตือนเข้า Discord/Slack
   * มี Throttling ป้องกันการยิงแจ้งเตือนสแปมซ้ำซ้อนภายใน 15 นาที
2. **Epic 1.2 — Extension Proactive Health Probe**
   * ใน [`injected.js`](file:///Users/kimlenglim/Project/gemini-web-bridge/extension-cloudflare/injected.js) ส่งคำขอ lightweight HEAD request ไปยัง `gemini.google.com` เป็นระยะ
   * ตรวจสอบว่า Google Login Cookie หรือ Token ยังมีผลบังคับใช้อยู่หรือไม่ ก่อนที่คำขอจริงของผู้ใช้จะล้มเหลว

---

### 🟡 Sprint 2: Context Persistence & Vector Memory (Mid-Term)

* **เป้าหมาย:** จดจำบทสนทนาย้อนหลังข้ามเซสชัน และสร้างระบบ Semantic Search (RAG) สำหรับ MCP Tools
* **ความยาก:** ปานกลาง (5-7 วัน) | **เทคโนโลยี:** Cloudflare D1 + Vectorize + GCP Vertex AI

#### Tasks ย่อย:
1. **Epic 2.1 — D1 SQL Conversation Store**
   * สร้างตาราง `conversations` และ `messages` ใน Cloudflare D1
   * บันทึกคำถาม-คำตอบ พร้อม Tool Call Parameters ลงฐานข้อมูล
   * มีระบบ Auto-Pruning ล้างข้อมูลเก่าเกิน 30 วัน
2. **Epic 2.2 — Multilingual Embeddings via GCP Vertex AI**
   * เชื่อมต่อ `text-embedding-004` บน Vertex AI เพื่อแปลงข้อความภาษาไทยและ Source Code เป็น Vectors (768 มิติ)
   * อัปโหลด Vectors เข้า Cloudflare Vectorize
3. **Epic 2.3 — MCP Context Injection**
   * เพิ่ม MCP Tool: `query_context_memory(query, top_k)`
   * ปรับแต่ง `sdlc_solution_architect` ให้ดึงประวัติการออกแบบที่เกี่ยวข้องในอดีตมาช่วยวิเคราะห์

---

### ⚪ Sprint 3: Multi-Session Load Balancing (Long-Term)

* **เป้าหมาย:** กระจายคำขอไปยัง Chrome Extension หลายเครื่อง / หลายบัญชีพร้อมกัน
* **ความยาก:** สูง (7-10 วัน) | **เทคโนโลยี:** Cloudflare Durable Object Router

#### Tasks ย่อย:
1. **Epic 3.1 — BridgeRouterDO**
   * แยก DO ออกเป็น 2 ระดับ: `BridgeRouterDO` (ศูนย์ควบคุม) และ `GeminiBridgeDO` (แต่ละ Session)
2. **Epic 3.2 — Session Identity & Least-Loaded Routing**
   * ให้ Chrome Extension แต่ละเครื่องระบุ `sessionId` ใน Connection WSS URL
   * Router กระจายโหลดคำขอแบบ Least-Connections / Round-Robin
3. **Epic 3.3 — Multi-Turn Sticky Sessions**
   * ผูก Multi-turn Conversation เดิมให้อยู่กับเบราว์เซอร์เครื่องเดิมจนกว่าจะจบ Session

---

## 4. คู่มือการปฏิบัติงาน (Operational Runbook)

### 4.1 การทดสอบระบบ (Running Automated Tests)

```bash
# ทดสอบ Unit Tests ทั้งหมด (69 tests)
cd cloudflare-worker && node --test tests/*.test.mjs

# ทดสอบเฉพาะ Red Team Adversarial Security Suite
cd cloudflare-worker && node --test tests/red-team-adversarial.test.mjs

# ทดสอบเฉพาะ Remote MCP Protocol Suite
cd cloudflare-worker && node --test tests/mcp-protocol.test.mjs
```

### 4.2 การ Deploy ขึ้น Cloudflare Workers Production

> [!NOTE]
> ในเครื่อง macOS ของ User บัญชี Wrangler ผูกกับตัวแปรสภาพแวดล้อม `HOME=/Users/kimlenglim`

```bash
# ตรวจสอบการ Login และสิทธิ์
HOME=/Users/kimlenglim npx wrangler whoami

# สั่ง Deploy โค้ดขึ้น Production
cd cloudflare-worker && HOME=/Users/kimlenglim npx wrangler deploy
```

### 4.3 การตรวจสอบสุขภาพของระบบจริง (Live Verification)

```bash
# 1. เช็กสถานะ Dashboard
curl -s https://gemini-web-bridge.taijustarrett417.workers.dev/health | jq .

# 2. เช็กสถานะเชิงลึกผ่าน MCP Health Tool
curl -s -X POST https://gemini-web-bridge.taijustarrett417.workers.dev/mcp \
  -H "Authorization: Bearer hermes-secret-key-2026" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_bridge_health","arguments":{}}}' \
  | jq '.result.content[0].text | fromjson'

# 3. ทดสอบยิง OpenAI Chat Completion แบบรวดเร็ว
curl -s -X POST https://gemini-web-bridge.taijustarrett417.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer hermes-secret-key-2026" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-web-thinking","messages":[{"role":"user","content":"Ping"}]}' | jq .
```

---

## 5. ตาราง Environment Secrets & Configurations

| ชื่อตัวแปร / Secret | ความจำเป็น | หน้าที่การทำงาน | การตั้งค่า |
|:---|:---:|:---|:---|
| `CLIENT_API_TOKEN` | **จำเป็น (Required)** | ใช้ตรวจสอบ Bearer Token ของ AI Client ที่เรียกเข้ามายัง Worker | `wrangler secret put CLIENT_API_TOKEN` |
| `BRIDGE_AUTH_TOKEN` | **จำเป็น (Required)** | ใช้ตรวจสอบรหัสผ่านตอน Chrome Extension เชื่อมต่อ WSS เข้ามาที่ `/bridge` | `wrangler secret put BRIDGE_AUTH_TOKEN` |
| `GEMINI_API_KEY` | **แนะนำ (Recommended)** | ใช้สำหรับ **GCP Hybrid Fallback** ให้ระบบสลับไปใช้ Gemini API อัตโนมัติเมื่อเบราว์เซอร์ออฟไลน์ | `wrangler secret put GEMINI_API_KEY` |
| `WEBHOOK_URL` | *ตัวเลือก (Sprint 1)* | URL สำหรับส่งแจ้งเตือน Discord / Slack เมื่อเกิดสถานะ Unhealthy | `wrangler secret put WEBHOOK_URL` |

---

## 6. กฎเหล็กและข้อบังคับ (Guardrails Reference)

ทุกการพัฒนาหรือสร้าง PR ในอนาคต **ต้องผ่านการตรวจสอบตามกฎ 5 เสาหลักใน [GUARDRAILS.md](file:///Users/kimlenglim/Project/gemini-web-bridge/GUARDRAILS.md)**:

1. **G1 (Zero-Token-Leak):** Google CSRF Token (`SNlM0e`) ต้องอยู่ใน RAM ของ MAIN World เท่านั้น ห้ามส่งออกนอกเบราว์เซอร์เด็ดขาด
2. **G2 (Strict Fail-Closed):** ห้ามใช้ Canned Responses หรือสร้างข้อมูลเท็จ (No Mock) เมื่อระบบไม่พร้อมต้องตอบ 503 หรือ 422 อย่างซื่อสัตย์
3. **G3 (State Isolation):** 1 Concurrent Request ต่อ Session, คิวรอไม่เกิน 10 รายการ และ Timeout 60s
4. **G4 (Zero Debt & 100% Pass):** ห้ามทิ้ง `TODO`/`FIXME` ในโค้ด และทุก PR ต้องรันผ่าน 69/69 Unit Tests โดยไม่มีข้อผิดพลาด
5. **G5 (Hybrid Governance):** เมื่อสลับไปใช้ GCP Fallback ต้องส่ง Header `X-Provider: google-cloud-fallback` ให้ Client ทราบเสมอ

---

> **เอกสารอ้างอิงร่วม:**
> * ข้อบังคับความปลอดภัย: [GUARDRAILS.md](file:///Users/kimlenglim/Project/gemini-web-bridge/GUARDRAILS.md)
> * แผนงานเชิงเทคนิคเดิม: [PLANNING-HANDOFF.md](file:///Users/kimlenglim/Project/gemini-web-bridge/PLANNING-HANDOFF.md)
> * สถาปัตยกรรมระบบ: [ARCHITECTURE.md](file:///Users/kimlenglim/Project/gemini-web-bridge/ARCHITECTURE.md)
