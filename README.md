# ⚡ Gemini Web Bridge (Cloudflare Durable Objects Edition)

> **Transform Google Gemini Web Sessions into Remote MCP Server and OpenAI-Compatible REST API with Tool Emulation via Cloudflare Workers Durable Objects.**

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20Durable%20Objects-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension%20MV3%20Protocol%20v2-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![MCP Protocol](https://img.shields.io/badge/MCP-2024--11--05-8A2BE2)](https://modelcontextprotocol.io/)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-412991?logo=openai&logoColor=white)](https://platform.openai.com/docs/api-reference)

**Gemini Web Bridge (v4.2.0)** คือระบบ Edge AI Gateway และ Chrome Extension (Protocol v2) ที่เชื่อมต่อเซสชันการทำงานจริงของ Google Gemini Web เข้าสู่ระบบ **Cloudflare Durable Objects** เพื่อให้บริการเป็น **OpenAI-Compatible REST API** (พร้อม SSE Streaming & Tool Emulation) และ **Remote Model Context Protocol (MCP) Server**

ทำให้ AI Agents ภายนอก เช่น **Hermes Agent**, **Cursor**, **Cline**, และ **Claude Code** สามารถเรียกใช้ความสามารถคิดวิเคราะห์เชิงลึก (Deep Thinking) และรัน Agentic Tool Loops บน Google Gemini Web Session จริง 100% ได้อย่างปลอดภัย รวดเร็ว และไร้การ Mock หลอก

---

## 🌟 จุดเด่นหลัก (Key Highlights)

- **⚡ Cloudflare Durable Objects Hub**: สถาปัตยกรรม Stateful In-Memory Coordination (`GeminiBridgeDO`) ผสาน WebSocket จากเบราว์เซอร์และ HTTP/REST จาก AI Client เข้าสู่ RAM เดียวกันบน Cloudflare Edge พร้อมการันตี FIFO queueing และ isolation
- **🔄 Dynamic Browser Model Sync & Catalog Mapping**: ซิงก์รายการโมเดลจริงที่พร้อมใช้งานจากหน้าเว็บ Gemini แบบเรียลไทม์ (เช่น `gemini-3.8-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-pro`, `gemini-web-thinking`) ผ่าน `/v1/models` พร้อมสถานะการตรวจสอบ (`discovered`, `learning`, `verified`, `stale`, `unsupported`)
- **🛠️ OpenAI-Compatible Tool Emulation**: รองรับ Tool / Function Calling สำหรับ Agentic Workflows (เช่น `terminal`, `git`, `read_file`, `write_file`, หรือ Custom Client Schemas) โดยแปลงเป็น Prompt Directives และถอดรหัสผลลัพธ์กลับเป็น OpenAI SSE `tool_calls` chunks พร้อม `finish_reason: "tool_calls"`
- **🛡️ Chrome Extension Protocol v2 & Dedicated-Tab Coordinator**: Background Service Worker ทำหน้าที่เลือก Leader Tab อัตโนมัติ ป้องกันหลายแท็บแย่งการเชื่อมต่อ พร้อม Failover ทันทีหากแท็บปิดตัว
- **🔒 Privacy-First Security (Zero-Token-Leak)**: Google CSRF Token (`SNlM0e`) ถูกเก็บรักษาไว้ในหน่วยความจำของ MAIN World ในเบราว์เซอร์เท่านั้น ไม่มีการส่งข้ามไปยัง Content Script หรือส่งผ่านเครือข่ายไปยัง Cloudflare Worker
- **🛡️ Strict Fail-Fast Architecture**: ขจัดปัญหา Canned/Mock หลอก หาก Extension ออฟไลน์ หรือโมเดลยังไม่ผ่านการ Verify ในเบราว์เซอร์ ระบบจะตอบกลับอย่างซื่อสัตย์ด้วย HTTP 503 หรือ 422 ทันที
- **🌊 Full SSE Streaming**: รองรับ `stream: true` ตามมาตรฐาน OpenAI ตอบกลับแบบ Chunk เรียลไทม์ พร้อมปิดด้วย `data: [DONE]`
- **🔧 Remote MCP Server**: รองรับ JSON-RPC 2.0 พร้อมชุดเครื่องมือ SDLC Solution Architect เต็มรูปแบบ

---

## 🏗️ สถาปัตยกรรมระบบ (Architecture Overview)

```text
┌────────────────────────────────────────────────────────────────────────┐
│                          Clients (HTTPS / REST)                        │
│   • Hermes Agent (Primary Model, Agentic Tool Loops & MCP Tools)       │
│   • Cursor / Cline / Continue (OpenAI-Compatible API + SSE)            │
│   • Gemini Spark / Claude Code (Remote MCP Server)                     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (Bearer Token Auth + SSE Stream)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│              Cloudflare Worker (gemini-web-bridge)                     │
│                                                                        │
│   GET  /                    Health Check & Status Dashboard (Public)   │
│   POST /v1/chat/completions OpenAI Chat Completions (SSE Streaming)    │
│   GET  /v1/models           Dynamic Model Catalog & Recommendations    │
│   POST /mcp                 Model Context Protocol (JSON-RPC 2.0)      │
│   GET  /bridge              WebSocket Secure (WSS) Stateful Hub        │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │            Durable Object: GeminiBridgeDO                      │   │
│   │   • Stateful RAM Coordination: WSS Tab ↔ Client HTTP Req       │   │
│   │   • Dynamic Model Catalog & Revision Tracking                  │   │
│   │   • Tool Emulation Engine (OpenAI Tools ↔ System Directives)   │   │
│   │   • FIFO Request Queue (Max 10 waiters, 60s timeout)           │   │
│   │   • Strict Fail-Fast: 503 on Extension Disconnect              │   │
│   └────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (WSS Bi-directional Protocol v2)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Chrome Extension (Protocol v2 — Manifest V3)                           │
│ ├─ background.js       Dedicated-Tab Coordinator (Leader/Standby)      │
│ ├─ content.js          Isolated World: WSS Client, Model UI Selector   │
│ ├─ injected.js         MAIN World: Native RPC Interceptor (CSP-Immune) │
│ ├─ model-adapter.js    Safe Replay Payload Builder                     │
│ └─ evidence-registry.js Session Epoch Bound Evidence (Fail-Closed)     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (First-Party Session Cookies)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Google Gemini Web Session (https://gemini.google.com/)                 │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 📁 โครงสร้างโปรเจกต์ (Repository Structure)

```text
gemini-web-bridge/
├── cloudflare-worker/             # Cloudflare Worker Edge Gateway (Durable Objects)
│   ├── wrangler.toml              # การตั้งค่า DO Bindings, Migrations, Env Vars
│   ├── README.md                  # คู่มือทางเทคนิคของ Worker & Tool Emulator
│   ├── src/
│   │   ├── index.js               # Core Worker: GeminiBridgeDO, REST API, MCP, WSS Hub
│   │   ├── model-catalog.js       # Dynamic Catalog Normalization & Recommendation
│   │   └── tool-emulator.ts       # OpenAI Tool Calling Emulation & SSE Transformer
│   ├── tests/                     # Unit & Integration Tests (Worker + Extension)
│   ├── scripts/                   # Verification Scripts (Production, Hermes, Chat)
│   └── patches/                   # Hermes Provider Patches
├── extension-cloudflare/          # Chrome Extension Manifest V3 (Protocol v2)
│   ├── manifest.json              # กำหนด declarative MAIN world scripts และ permissions
│   ├── background.js              # Centralized Dedicated-Tab Coordinator
│   ├── content.js                 # Isolated World WSS Client & Model Selector
│   ├── injected.js                # MAIN World Interceptor (CSP-immune, Zero CSRF leak)
│   ├── model-adapter.js           # Structural Adapter สำหรับ Replay Payload
│   ├── evidence-registry.js       # Session-bound Evidence & Model Verification
│   ├── tab-coordinator.js         # Tab election fallback logic
│   ├── settings.js / options.*    # Settings resolution & Diagnostics UI
│   └── icons/                     # Extension Icons
├── docs/                          # คู่มือและเอกสารการใช้งาน
│   └── client-configs.md          # คู่มือการตั้งค่า Client แต่ละประเภทโดยละเอียด
├── tests/                         # End-to-End & Integration Test Scripts
├── ARCHITECTURE.md                # รายละเอียดเชิงลึกของสถาปัตยกรรมและ Protocol Spec
├── IDEA.md                        # บันทึกแนวคิดและ Roadmap ของระบบ
└── README.md                      # เอกสารแนะนำและคู่มือเริ่มต้นใช้งาน
```

---

## 🚀 เริ่มต้นใช้งานอย่างรวดเร็ว (Quickstart)

### 1. Deploy Cloudflare Worker

```bash
cd cloudflare-worker
npm install
npx wrangler deploy
```
*Worker จะถูก Deploy ไปที่ `https://gemini-web-bridge.<account>.workers.dev`*

#### ตั้งค่าตัวแปรความปลอดภัย (Secrets / Vars)
ใน `cloudflare-worker/wrangler.toml` หรือผ่าน Cloudflare Dashboard:
- `BRIDGE_SECRET`: รหัสลับสำหรับยืนยันตัวตนระหว่าง Extension และ Worker
- `CLIENT_API_KEY`: รหัส Bearer Token สำหรับ Client เรียกใช้งาน (เช่น `hermes-secret-key-2026`)
- `GEMINI_API_KEY`: (ตัวเลือก) Google Gemini API Key สำหรับระบบ Secondary Fallback

---

### 2. ติดตั้ง Chrome Extension (Cloud Edition)

1. เปิดเบราว์เซอร์ Google Chrome ไปที่ `chrome://extensions/`
2. เปิดสวิตช์ **Developer mode** ที่มุมขวาบน
3. คลิกปุ่ม **Load unpacked**
4. เลือกโฟลเดอร์ `gemini-web-bridge/extension-cloudflare`
5. เปิดหน้าเว็บ https://gemini.google.com/ แล้วล็อกอินบัญชี Google ให้เรียบร้อย
6. กดดู Console (F12) จะพบข้อความ:
   ```text
   [Bridge] 🔌 Connecting to Worker: wss://gemini-web-bridge.../bridge
   [Bridge] ✅ Bridge Connected Successfully
   [Bridge] ✅ Session Ready: Tokens synchronized
   ```

---

### 3. เชื่อมต่อ Client

#### ก. Hermes Agent (ใช้เป็น Primary Model Provider & MCP Tools)
แก้ไขไฟล์ `~/.hermes/config.yaml`:
```yaml
model:
  default: gemini-web-thinking
  provider: gemini-web-bridge
  base_url: https://gemini-web-bridge.taijustarrett417.workers.dev/v1
  api_key: hermes-secret-key-2026

providers:
  gemini-web-bridge:
    capabilities:
      reasoning: false
    type: custom
    name: gemini-web-bridge
    base_url: https://gemini-web-bridge.taijustarrett417.workers.dev/v1
    api_key: hermes-secret-key-2026
    discover_models: true
    refresh_models_on_connect: true
    default_model: gemini-web-thinking
    models: []
    timeout: 120
    connect_timeout: 30

mcp_servers:
  gemini-web-bridge:
    url: https://gemini-web-bridge.taijustarrett417.workers.dev/mcp
    headers:
      Authorization: "Bearer hermes-secret-key-2026"
```

> [!TIP]
> **Dynamic Model Catalog & Tool Emulation**: เมื่อเปิดหน้าเว็บ Gemini ขึ้นมา ระบบจะซิงก์โมเดลที่มีในเบราว์เซอร์ (`gemini-3.8-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-pro`, `gemini-web-thinking`) เข้ามายัง Hermes โดยอัตโนมัติ พร้อมรองรับ Agentic Tool Loop ผ่านระบบ Tool Emulation ในตัว

ทดสอบการใช้งานใน Terminal:
```bash
# คุยกับ Hermes ผ่านโมเดลหลัก
hermes -z "ออกแบบระบบ Distributed Cache ด้วย Redis และ Go"

# เรียกใช้ MCP Tool เฉพาะทาง
hermes -z "ออกแบบ System Architecture" -t gemini-web-bridge
```

#### ข. Cursor / Cline
- **Base URL**: `https://gemini-web-bridge.taijustarrett417.workers.dev/v1`
- **API Key**: `hermes-secret-key-2026`
- **Model**: `gemini-web-thinking` หรือ `gemini-web`

#### ค. Python OpenAI SDK
```python
from openai import OpenAI

client = OpenAI(
    base_url="https://gemini-web-bridge.taijustarrett417.workers.dev/v1",
    api_key="hermes-secret-key-2026"
)

response = client.chat.completions.create(
    model="gemini-web-thinking",
    messages=[{"role": "user", "content": "วิเคราะห์ข้อดีข้อเสียของ Microservices vs Monolith"}],
    stream=True
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

---

## 🛠️ การรองรับ Tool Calling & Function Emulation

นอกเหนือจาก MCP Server แล้ว Gemini Web Bridge ยังมี **Built-in Tool Calling Emulator** (`cloudflare-worker/src/tool-emulator.ts`) ที่เปิดให้โมเดลเว็บรัน Tool Loops ของ OpenAI Function Calling API ได้:

| Emulated Tool | คำอธิบายการทำงาน |
|:---|:---|
| `terminal` | สั่งรันคำสั่ง Shell / Terminal ในเครื่อง Client |
| `git` | จัดการ Git Commands (`status`, `diff`, `commit`, `push`, etc.) |
| `read_file` | อ่านเนื้อหาไฟล์ใน Disk จากพาธที่กำหนด |
| `write_file` | เขียนและบันทึกเนื้อหาลงไฟล์ |
| *Custom Tools* | รองรับ JSON Schema ของ Tools ใดๆ ที่ Client กำหนดส่งผ่านพารามิเตอร์ `tools` |

- **Streaming & SSE**: แปลงคำตอบของ Gemini ออกมาเป็น Chunk ของ `tool_calls` ตามมาตรฐาน OpenAI พร้อม `finish_reason: "tool_calls"`
- **Multi-turn History**: จัดเก็บและรักษาลำดับบทสนทนารวมทั้ง `role: "tool"` และ `tool_call_id` ข้าม Turn ได้อย่างสมบูรณ์

---

## 🧰 รายการ MCP Tools ที่มีให้ใช้งาน

| Tool Name | คำอธิบาย |
|:---|:---|
| `sdlc_solution_architect` | วิเคราะห์ปัญหา ออกแบบสถาปัตยกรรมระบบ Component Model, Data Flow และ Implementation Roadmap |
| `orchestrate_sdlc_plan` | วางแผน Roadmap และแตก Task ย่อยตามวงจร SDLC (Plan → Arch → Code → Test → Deploy) |
| `code_review_and_debug` | ตรวจสอบโค้ด หาสาเหตุของ Bug (Root Cause), แนะนำ Patch แก้ไข และตรวจสอบ Security |
| `evaluate_tech_tradeoffs` | วิเคราะห์เปรียบเทียบข้อดี-ข้อเสียของเทคโนโลยี (Trade-off Matrix) เพื่อประกอบการตัดสินใจ |
| `ping` | ตรวจสอบสถานะการเชื่อมต่อของ Cloud Hub, Chrome Extension และ Engine Mode |

---

## 🔍 การตรวจสอบและดีบัก (Verification & Monitoring)

- **Real-time Logs ผ่าน Cloudflare Wrangler:**
  ```bash
  cd cloudflare-worker
  npx wrangler tail --format pretty
  ```
- **Health Check ผ่าน cURL:**
  ```bash
  curl -s https://gemini-web-bridge.taijustarrett417.workers.dev/ | jq
  ```
- **ทดสอบ MCP Tools ผ่าน Hermes:**
  ```bash
  hermes mcp test gemini-web-bridge
  ```

---

## 📄 เอกสารเพิ่มเติม (Documentation Links)
- [คู่มือการตั้งค่า Client ทั้งหมด (docs/client-configs.md)](docs/client-configs.md)
- [รายละเอียดสถาปัตยกรรมและ Data Flow (ARCHITECTURE.md)](ARCHITECTURE.md)
- [แนวคิดและการออกแบบระบบ (IDEA.md)](IDEA.md)

---

## 📜 License
MIT License. พัฒนาขึ้นเพื่อการศึกษาและการบูรณาการระบบ AI ภายในองค์กรอย่างมีประสิทธิภาพ
