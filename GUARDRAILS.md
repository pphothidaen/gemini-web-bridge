# 🛡️ Gemini Web Bridge — Architectural & Execution Guardrails

> **เอกสารข้อบังคับและกฎเหล็ก (Guardrails) สำหรับการพัฒนา, การรัน Subagents, และการขยายระบบตาม Roadmap**  
> **Baseline:** v4.2.0 | **สถานะ:** Active & Enforced  
> **เป้าหมาย:** ป้องกัน System Regression, รักษาความปลอดภัย Zero-Token-Leak, ป้องกันการสร้างข้อมูลเท็จ (No Fabrication), และควบคุมการเชื่อมต่อ Hybrid (Web Bridge + GCP)

---

## 🏛️ สรุปภาพรวม 5 เสาหลักของ Guardrails

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                      GEMINI WEB BRIDGE GUARDRAILS                           │
├─────────────────┬─────────────────┬─────────────────┬───────────────────────┤
│  G1: Security   │  G2: Integrity  │  G3: Isolation  │  G4: Regression Gate  │
│  Zero Token Leak│  Strict Fail-   │  DO RAM & State │  Zero Technical Debt  │
│  Bearer Auth    │  Closed (No Mock│  Queue Deadlines│  Automated Tests      │
├─────────────────┴─────────────────┴─────────────────┴───────────────────────┤
│                     G5: Hybrid & Fallback Governance                        │
│          Web Bridge (Primary) ↔ GCP Vertex AI / Gemini API (Fallback)       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. G1: Security & Token Privacy Guardrails (กฎเหล็กด้านความปลอดภัย)

### 1.1 Zero-Token-Leak (CSRF & Cookies)
* **[G1.1.1]** Google CSRF Token (`SNlM0e` / `at`) ต้องถูกเก็บและใช้งานภายใน **MAIN-world in-memory RAM** ของเบราว์เซอร์เท่านั้น ([`injected.js`](extension-cloudflare/injected.js))
* **[G1.1.2]** **ห้ามเด็ดขาด** ในการส่ง `SNlM0e`, Google Session Cookies, หรือ First-party tokens ใดๆ ผ่าน WebSocket, HTTP Headers, Storage หรือ Logs ไปยัง Cloudflare Worker
* **[G1.1.3]** การยืนยันตัวตนข้ามขอบเขต:
  * Extension ↔ Cloudflare DO: ใช้ `BRIDGE_SECRET` ผ่าน WSS handshake
  * AI Client ↔ Cloudflare DO: ใช้ `CLIENT_API_KEY` (Bearer Token)
  * Public Endpoint มีเพียง `/` และ `/health` เท่านั้น

### 1.2 Evidence Sanitization
* **[G1.2.1]** ในการบันทึกหรือส่ง Structural Evidence ([`evidence-registry.js`](extension-cloudflare/evidence-registry.js)) ต้อง sanitize ข้อความ Prompt ของผู้ใช้ทิ้ง 100% ห้าม persist ข้อความส่วนบุคคล

---

## 2. G2: Reliability & Strict Fail-Closed Policy (กฎความซื่อสัตย์ของระบบ)

### 2.1 No Fabrication & No Mocking
* **[G2.1.1]** **ห้ามใช้ Canned Responses หรือ Mock Data หลอก Client เด็ดขาด** หากระบบไม่สามารถประมวลผลผ่าน Gemini ได้จริง ต้องตอบ Error HTTP status ที่ถูกต้องทันที:
  * `503 Service Unavailable` (`code: "extension_disconnected"`): หาก Chrome Extension ไม่ได้ต่อ WSS
  * `422 Unprocessable Entity` (`code: "model_unverified"`): หากโครงสร้างโมเดลยังไม่ผ่านการ Verify
  * `429 Too Many Requests` (`code: "queue_full"`): หากคิวรอเกิน 10 requests
* **[G2.1.2]** Tool Emulation ต้องตรวจสอบ JSON schema ของ Tool Calls อย่างเข้มงวด ([`tool-emulator.ts`](cloudflare-worker/src/tool-emulator.ts)) หาก Output ผิดรูปแบบ ต้องส่ง Error ชัดเจน ไม่เดาสุ่ม

### 2.2 Session Epoch Invalidation
* **[G2.2.1]** ทุกครั้งที่ Extension Reconnect, สลับ Account, หรือ Google อัปเดต Build (`cfb2h`) สถานะ Evidence ของโมเดลทั้งหมดต้องถูก Reset เป็น `stale` หรือ `discovered` ทันที ห้ามใช้ Cache เก่าข้าม Session Epoch

---

## 3. G3: State Isolation & Durable Object Limits (ขอบเขตการทำงานบน Edge)

### 3.1 Concurrency & Queueing Limits
* **[G3.1.1]** แต่ละ Bridge Session รองรับการประมวลผลพร้อมกันได้สูงสุด **1 Request ต่อหนึ่งเวลา** (Single Concurrent Execution)
* **[G3.1.2]** คิวรอสูงสุดไม่เกิน **10 Requests** หากเกินให้ปฏิเสธด้วย HTTP `429` ทันที
* **[G3.1.3]** Queue Wait Deadline = **60 วินาที** และ Generation Execution Deadline = **60 วินาที** หากเกินต้อง Timeout และส่งสัญญาณ `CANCEL_REQUEST` ไปยัง Browser ทันที

### 3.2 Cloudflare DO Memory Hygiene
* **[G3.2.1]** ไม่เก็บ Response Chunks ขนาดใหญ่ค้างไว้ใน Memory ของ DO
* **[G3.2.2]** เมื่อ Client ยกเลิกคำขอ (`AbortSignal`) ต้องสั่ง Disconnect Stream และเคลียร์ Active Streams ทันที

---

## 4. G4: Quality & Regression Gates (ประตูควบคุมคุณภาพโค้ด)

### 4.1 Zero Technical Debt in Production Code
* **[G4.1.1]** ห้ามทิ้ง `TODO`, `FIXME`, `HACK`, `XXX`, หรือ `BLOCKER` ใน Production Source Code (`cloudflare-worker/src/` และ `extension-cloudflare/`) หากมีงานค้างต้องบันทึกใน `PLANNING-HANDOFF.md` เท่านั้น
* **[G4.1.2]** ห้ามใส่ Hardcoded Stale Strings (เช่น Fallback Build Versions) ในโค้ด ให้ใช้ Fail-Fast Mechanism แทน

### 4.2 Automated Testing Gate
* **[G4.2.1]** ทุกการเปลี่ยนแปลงโค้ด ต้องผ่าน Unit Test Suite:
  ```bash
  cd cloudflare-worker && node --test tests/*.test.mjs
  ```
  เกณฑ์ผ่าน: ขั้นต่ำ 54 passing tests และไม่มี regression จากโค้ดใหม่
* **[G4.2.2]** ห้าม bypass หรือปิด test assertions เพื่อให้ build ผ่าน

---

## 5. G5: Hybrid Architecture & Fallback Governance (Web Bridge + GCP)

### 5.1 บทบาทของ Gemini บน Google Cloud Platform (GCP / Vertex AI)

Gemini บน GCP สามารถเข้ามาเสริมระบบ Gemini Web Bridge ได้ใน 3 ด้านหลักภายใต้การควบคุม:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        Client Request (HTTPS)                          │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│               Cloudflare Worker (Hybrid Gateway Router)                │
│                                                                        │
│   ┌───────────────────────────┐      Failover / Embeddings / QA        │
│   │   Primary: Web Bridge     │───────────────────────────┐            │
│   │   (Gemini Web Session)    │                           │            │
│   └─────────────┬─────────────┘                           ▼            │
│                 │ (Status: 503 / Stale)        ┌─────────────────────┐ │
│                 ▼                              │ Secondary: GCP      │ │
│          [Browser Tab]                         │ (Vertex AI / Studio)│ │
│                                                └─────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

#### การประยุกต์ใช้งาน GCP Gemini ที่ได้รับอนุญาต:
1. **Secondary Fallback (High Availability)**:
   * เมื่อ Extension หลุดการเชื่อมต่อ หรือ Web Quota หมด ให้ Route อัตโนมัติไปยัง GCP Gemini API (ผ่าน `GEMINI_API_KEY`)
   * **ข้อกำหนด:** ต้องแนบ Header ตอบกลับ `X-Provider: google-cloud-fallback` เพื่อให้ Client ทราบแหล่งที่มาอย่างโปร่งใส
2. **Context Persistence & Vector Embeddings (Roadmap #2)**:
   * ใช้ Vertex AI Text Embedding API (`text-embedding-004` หรือ `text-multilingual-embedding-002`) เพื่อสร้าง Embedding ภาษาไทยและโค้ด สำหรับจัดเก็บลง Cloudflare Vectorize
3. **Automated Quality & Evaluation Agent (QA Guardrail)**:
   * ใช้ Gemini บน GCP ทำหน้าที่เป็น Automated Code Reviewer หรือ Tool Call Validator ใน CI/CD ตรวจสอบก่อน Release

### 5.2 บทบาทของ Gemini MCP (Model Context Protocol)

Cloudflare Worker ของระบบนี้ทำหน้าที่เป็น **Remote MCP Server** อยู่แล้วที่ Endpoint `/mcp`

#### แนวทางการใช้งานและขยาย MCP Tools:
* **Tool Calling ในปัจจุบัน:**
  1. `sdlc_solution_architect`: ออกแบบระบบและ Component Model
  2. `orchestrate_sdlc_plan`: แตกแผนงานตามวงจร SDLC
  3. `code_review_and_debug`: ตรวจสอบบั๊กและโค้ดแพตช์
  4. `evaluate_tech_tradeoffs`: เปรียบเทียบทางเลือกเทคโนโลยี
  5. `ping`: ตรวจสอบสถานะการเชื่อมต่อ Edge ↔ Browser
* **ข้อกำหนดในการเพิ่ม MCP Tool ใหม่:**
  * ต้องประกาศ Tool Schema ที่มี Type และ Description ชัดเจนใน `index.js`
  * ต้องรองรับ JSON-RPC 2.0 มาตรฐาน (Error code `-32601` สำหรับ method ไม่ถูกต้อง, `-32602` สำหรับ invalid params)
  * ต้องไม่ส่งผลกระทบต่อ SSE Streaming transport

---

## 6. Execution Protocol สำหรับ Autonomous Agents & Subagents

เมื่อ Agent (เช่น Antigravity, Subagents, หรือ Developer) ได้รับมอบหมายงานตาม Roadmap:

1. **Phase Check:** อ่าน `PLANNING-HANDOFF.md` ก่อนเริ่มเสมอ
2. **Constraint Verification:** ตรวจสอบ Guardrail ข้อ G1 - G5 ทุกครั้งก่อนเขียนโค้ด
3. **Sandbox Testing:** รัน Unit Test ตรวจสอบ Baseline ก่อนแก้ไข
4. **Implementation & Verify:** แก้ไขเฉพาะจุด ไม่แตะต้องระบบที่ทำงานดีอยู่แล้ว
5. **Regression Verification:** รัน Test Suite ซ้ำ และตรวจสอบ Git Status
6. **Documentation Update:** อัปเดตสถานะใน `PLANNING-HANDOFF.md` (TODO → DOING → DONE)

---

> [!IMPORTANT]
> **Zero Tolerance:** การละเมิดข้อกำหนด G1 (Token Leak) หรือ G2 (Mock/Fabrication) จะถือว่างานนั้นล้มเหลวทันทีและต้องถูก Rollback โค้ดกลับสู่สถานะเดิม
