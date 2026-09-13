# Gemini Web-Bridge: Architecture & Technical Specification

> **Detailed Architecture, Security Model, Wire-Protocol, and Data Flow for Gemini Web Bridge (Cloudflare Durable Objects & Extension Protocol v2 Edition).**

---

## 1. System Architecture Overview

Gemini Web Bridge (v4.2.0) เป็นระบบ **Edge-to-Browser Gateway** ที่ผสานการทำงานระหว่าง AI Clients ภายนอก (Hermes Agent, Cursor, Cline, Claude Code, Python SDK) เข้ากับ Google Gemini Web Session จริง ผ่านสถาปัตยกรรม **Cloudflare Durable Objects**

```text
                                  ┌──────────────────────────────────────────────┐
                                  │                  AI Clients                  │
                                  │   (Hermes Agent, Cursor, Cline, SDK, cURL)   │
                                  └──────────────────────┬───────────────────────┘
                                                         │ HTTPS (Bearer Auth)
                                                         ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   Cloudflare Worker (gemini-web-bridge)                                      │
│                                                                                                              │
│   ┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐   │
│   │                                       API Routing & Auth Layer                                       │   │
│   │   • Bearer Token Authentication (CLIENT_API_KEY)                                                     │   │
│   │   • Strict Fail-Fast Validation (No mock / canned responses)                                         │   │
│   │   • CORS Headers (Access-Control-Allow-*)                                                            │   │
│   └───────────────────┬──────────────────────────────────┬──────────────────────────────────┬────────────┘   │
│                       │                                  │                                  │                │
│                       ▼                                  ▼                                  ▼                │
│     ┌───────────────────────────────────┐ ┌─────────────────────────────┐ ┌────────────────────────────────┐ │
│     │   OpenAI REST API (/v1/*)         │ │   Remote MCP (/mcp)         │ │   WebSocket Hub (/bridge)      │ │
│     │   • /v1/models (GET)              │ │   • JSON-RPC 2.0 Handler    │ │   • Dedicated-Tab WebSocket    │ │
│     │   • /v1/chat/completions (POST)   │ │   • Mcp-Session-Id Tracker  │ │   • Protocol v2 Validation     │ │
│     │   • Multi-turn Message Aggregator │ │   • SDLC Tools Registry     │ │   • PING/PONG Keepalive (15s)  │ │
│     │   • SSE Stream Transformer        │ │   • Tools Call Dispatcher   │ │   • Bi-directional Message Bus │ │
│     └─────────────────┬─────────────────┘ └──────────────┬──────────────┘ └────────────────┬───────────────┘ │
│                       │                                  │                                 │                 │
│                       └─────────────────┬────────────────┘                                 │                 │
│                                         ▼                                                  │                 │
│                       ┌──────────────────────────────────────────────────┐                 │                 │
│                       │        Durable Object: GeminiBridgeDO            │                 │                 │
│                       │   • In-Memory RAM Coordination (WSS ↔ HTTP)      │◀────────────────┘                 │
│                       │   • Dynamic Model Catalog & Revision Tracking    │                                   │
│                       │   • Tool Emulation Engine (OpenAI Tools)         │                                   │
│                       │   • FIFO Request Queue (Max 10, 60s deadline)    │                                   │
│                       │   • Strict Fail-Fast: 503 on Disconnect          │                                   │
│                       └──────────────────────────────────────────────────┘                                   │
└─────────────────────────────────────────────────┬────────────────────────────────────────────────────────────┘
                                                  │
                                                  │ WebSocket Secure (WSS Protocol v2)
                                                  ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   Google Chrome (gemini.google.com)                                          │
│                                                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │   Background Service Worker (background.js)                                                            │  │
│  │   • Centralized Dedicated-Tab Coordinator via Persistent Ports                                         │  │
│  │   • Elects First Tab as Leader; Concurrent Tabs Assigned Standby                                       │  │
│  │   • Automatic Failover on Tab Close; Session Storage Leadership Persistence                            │  │
│  └───────────────────────────────────┬────────────────────────────────────────────────────────────────────┘  │
│                                      │                                                                       │
│  ┌───────────────────────────────────┴──────────────┐      ┌──────────────────────────────────────────────┐  │
│  │   Content Script (Isolated World)                │      │   Injected Script (Main World)               │  │
│  │   • Declarative Injection (CSP-Immune)           │      │   • Declarative run_at: document_start       │  │
│  │   • WSS Client to Durable Object (Leader only)   │ post │   • Holds SNlM0e in In-Memory RAM (Zero Leak)│  │
│  │   • Programmatic UI Model Selection on PREPARE   │◀────▶│   • Early Fetch/XHR Interceptor (Native RPC) │  │
│  │   • Model Adapter Replay Payload Construction    │ msg  │   • Unhooked Direct Fetch Replay Execution   │  │
│  │   • Session Epoch Bound Evidence Invalidation    │      │   • Response Qualification (200 OK + wrb.fr) │  │
│  └──────────────────────────────────────────────────┘      └──────────────────────┬───────────────────────┘  │
│                                                                                   │ First-Party Cookies      │
└───────────────────────────────────────────────────────────────────────────────────┼──────────────────────────┘
                                                                                    │ HTTPS POST
                                                                                    ▼
                                                             ┌──────────────────────────────────────────────┐
                                                             │   Google Gemini Web Production Backend       │
                                                             │   (_/BardChatUi/data/assistant.lamda...)     │
                                                             └──────────────────────────────────────────────┘
```

---

## 2. Context Boundaries & Security Model

ระบบแบ่งขอบเขตความปลอดภัยออกเป็น 3 ระดับอย่างเข้มงวด:

### 2.1 Client-to-Edge Boundary (HTTPS)
- **Authentication**: ทุกคำขอที่ส่งไปยัง `/v1/*` และ `/mcp` ต้องแนบ Header:
  ```http
  Authorization: Bearer <CLIENT_API_KEY>
  ```
- **Public Exceptions**: มีเพียง `/` (Health Dashboard) เท่านั้นที่เปิดสาธารณะ ส่วน `/bridge` บังคับใช้ Protocol v2 Bridge Secret Verification
- **Transport**: บังคับใช้ TLS/HTTPS 100% ผ่าน Cloudflare Edge พร้อม Cache-Control `no-store` สำหรับ dynamic endpoints

### 2.2 Edge-to-Browser Boundary (WSS Protocol v2)
- **Authentication**: Extension ต้องส่ง `BRIDGE_SECRET` ในจังหวะ Handshake เพื่อยืนยันตัวตน
- **Single Active Bridge Tab**: ระบบรับประกันว่ามีเพียงแท็บ Leader เดียวเท่านั้นที่เชื่อมต่อ WebSocket ไปยัง DO Hub ป้องกันการชนกันของคำสั่ง
- **Session-bound Token Protection**: Google CSRF Token (`SNlM0e`) จะถูกเก็บไว้ใน MAIN-world in-memory เท่านั้น **ไม่มีการส่งผ่าน WSS ไปยัง Cloudflare Worker**

### 2.3 Browser Execution Boundary (CSP & Contexts)
- **Declarative MAIN World Injection**:
  - `injected.js` ถูกกำหนดใน `manifest.json` ด้วย `"world": "MAIN"`, `"run_at": "document_start"` เพื่อให้ติดตั้ง Interceptor ก่อนสคริปต์หน้าเว็บจะรัน โดยไม่ติดนโยบาย Content Security Policy (CSP)
- **Isolated World (`content.js`)**:
  - ทำหน้าที่เป็นสะพานสื่อสาร (Relay) ระหว่าง WebSocket กับ MAIN world ผ่าน `window.postMessage` ที่มีการตรวจสอบ Type อย่างรัดกุม
- **Evidence Registry & Invalidation**:
  - หลักฐานการเรียก RPC (Generation Evidence) จะผูกติดกับ `sessionEpoch`
  - หากมีการ Reconnect, Account Change หรือ Build Version Change (`cfb2h`) หลักฐานทั้งหมดจะถูก Invalidate ทันที ป้องกันการใช้ Schema เก่าที่ตกรุ่น

---

## 3. Sequence Diagrams

### 3.1 OpenAI-Compatible SSE Streaming (`/v1/chat/completions`)

```text
Client (Hermes/Cursor)       GeminiBridgeDO (Edge RAM)    content.js (Isolated)      injected.js (Main)         Gemini Web Backend
        │                            │                            │                          │                        │
        │─── POST /chat/completions ─▶                            │                          │                        │
        │    (stream: true)          │                            │                          │                        │
        │                            │─── PREPARE_MODEL (WSS) ───▶│                          │                        │
        │                            │                            │ (Verify / Select in UI)  │                        │
        │                            │◀── MODEL_READY (WSS) ──────│                          │                        │
        │                            │                            │                          │                        │
        │                            │─── EXECUTE_REQUEST (WSS) ─▶│                          │                        │
        │                            │                            │─── postMessage(STREAM) ─▶│                        │
        │                            │                            │                          │─── Native fetch() ────▶│
        │                            │                            │                          │◀── Batched RPC Stream ─│
        │                            │                            │◀── postMessage(CHUNK) ───│                        │
        │                            │◀── STREAM_CHUNK (WSS) ─────│                          │                        │
        │◀── data: {choices:[...]} ──│                            │                          │                        │
        │        ... (Chunks) ...    │        ... (Chunks) ...    │      ... (Chunks) ...    │                        │
        │                            │                            │◀── postMessage(DONE) ────│                        │
        │                            │◀── STREAM_DONE (WSS) ──────│                          │                        │
        │◀── data: [DONE] ───────────│                            │                          │                        │
```

### 3.2 Tool Emulation Loop (OpenAI Function Calling)

```text
Client (Hermes Agent)        GeminiBridgeDO (tool-emulator) Extension (Protocol v2)  Gemini Web Backend
        │                            │                            │                        │
        │─── POST /chat/completions ─▶                            │                        │
        │    messages + tools: [...] │                            │                        │
        │                            │ (Inject Tool Directives    │                        │
        │                            │  into System Prompt)       │                        │
        │                            │─── EXECUTE_REQUEST ───────▶│─── Native fetch() ────▶│
        │                            │                            │◀── Raw Gemini Stream ──│
        │                            │◀── STREAM_CHUNK ───────────│                        │
        │                            │                            │                        │
        │                            │ (createToolCallTransformer │                        │
        │                            │  detects <tool_call> tags) │                        │
        │◀── data: delta.tool_calls ─│                            │                        │
        │◀── finish_reason: tool_call│                            │                        │
        │◀── data: [DONE] ───────────│                            │                        │
        │                            │                            │                        │
        │─── POST /chat/completions ─▶                            │                        │
        │    append tool result      │─── Fresh Execution Loop ──▶│                        │
```

### 3.3 Dynamic Model Discovery & Sync

```text
Gemini Browser Tab           Extension (content.js)       GeminiBridgeDO (Edge)      Client (/v1/models)
        │                            │                            │                        │
        │─── UI Dropdown Rendered ──▶│                            │                        │
        │                            │─── MODELS_DISCOVERED ─────▶│                        │
        │                            │    models: [...], v: 2     │ (Update Catalog & Rev) │
        │                            │                            │                        │
        │                            │                            │◀── GET /v1/models ─────│
        │                            │                            │─── Normalized Catalog ─▶│
        │                            │                            │    default_recommended │
```

---

## 4. Execution, Queueing & Strict Fail-Fast Policy

ระบบถูกออกแบบมาเพื่อ **Zero Fabrication & Strict Reliability**:

1. **Strict Fail-Fast (No Mock Responses)**:
   - หาก Chrome Extension ไม่ได้เชื่อมต่อ ระบบจะตอบกลับทันทีด้วย HTTP `503 Service Unavailable` (`code: "extension_disconnected"`)
   - หากโมเดลที่ร้องขอยังไม่ได้รับการยืนยัน (Unverified) ระบบจะให้เวลาเรียนรู้ 10 วินาที หากไม่พบโครงสร้าง Payload ที่ถูกต้อง จะตอบกลับด้วย HTTP `422 Unprocessable Entity` (`code: "model_unverified"`)
   - ไม่มีการใช้ Canned responses หรือ Mock responses หลอก AI Client อย่างเด็ดขาด

2. **FIFO Session Queueing**:
   - แต่ละ Bridge Session รองรับ 1 Concurrent Execution และรอในคิวได้สูงสุด 10 Requests
   - คิวมี Deadline 60 วินาที และการรันแต่ละคำขอมี Generation Deadline 60 วินาที
   - หากคิวเต็ม ระบบจะตอบกลับด้วย HTTP `429 Too Many Requests`
   - เมื่อไคลเอนต์ยกเลิกคำขอ (Client Abort) คิวจะถูกเคลียร์และส่งสัญญาณ `CANCEL_REQUEST` ไปยังเบราว์เซอร์ทันที

3. **Centralized Tab Coordinator**:
   - `background.js` จัดการ persistent port connections จากทุกแท็บของ gemini.google.com
   - แท็บแรกที่เชื่อมต่อจะได้รับบทบาท `leader` และเปิด WebSocket ไปยัง Worker
   - แท็บที่เปิดขึ้นมาทีหลังจะเป็น `standby` และไม่เปิด WebSocket ซ้ำซ้อน
   - เมื่อแท็บ `leader` ปิดตัว Coordinator จะโปรโมทแท็บ `standby` ถัดไปเป็น `leader` ทันทีภายในเสี้ยววินาที

---

## 5. Wire-Protocol & Decoding Mechanics

### 5.1 Extension Protocol v2 Messages
- **`SESSION_READY`**: แจ้งสถานะความพร้อมของเซสชัน, `buildLabel`, และ `sessionEpoch` (โดยไม่ส่ง CSRF token)
- **`MODELS_DISCOVERED`**: ส่งรายการโมเดลที่ตรวจพบจากหน้าเว็บพร้อมสถานะ verification
- **`PREPARE_MODEL`**: Worker ร้องขอให้ Extension ปรับเลือกโมเดลใน UI ก่อนเริ่มประมวลผล
- **`MODEL_READY`**: Extension ยืนยันว่าโมเดลใน UI ถูกเลือกและ Replay mapping พร้อมใช้งาน
- **`EXECUTE_REQUEST`**: Worker ส่งข้อความคำขอพร้อม `mappingRevision` ที่ได้รับการตรวจสอบแล้ว
- **`STREAM_CHUNK` / `STREAM_DONE` / `STREAM_ERROR`**: การส่งต่อผลลัพธ์แบบ Streaming จากเบราว์เซอร์กลับไปยัง Edge
- **`CANCEL_REQUEST`**: สั่งยกเลิกการประมวลผลคำขอที่กำลังทำงานอยู่

### 5.2 Gemini Production Decoding
Google Gemini Web UI ใช้ Batched RPC Payload บนเส้นทาง `/_/BardChatUi/data/assistant.lamda`:

- **Envelope Parsing**:
  1. คัดกรอง Prefix Guard: `)]}'`
  2. แยก Chunk ตามลำดับบรรทัด
  3. ตรวจสอบ Array Header ที่ตรงกับ `wrb.fr`
- **Data Index Mapping**:
  - `innerData[4][0][1][0]`: ข้อความผลลัพธ์ (Response Text Delta)
  - `innerData[1][0]`: Conversation ID (สำหรับต่อบทสนทนา)
  - `innerData[1][1]`: Response ID
  - `innerData[4][0][0]`: Choice ID
