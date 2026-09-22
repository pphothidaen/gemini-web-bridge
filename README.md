# ⚡ Gemini Web Bridge

<div align="center">

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20Durable%20Objects-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension%20MV3%20Protocol%20v2-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![MCP Protocol](https://img.shields.io/badge/MCP-2024--11--05-8A2BE2)](https://modelcontextprotocol.io/)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-412991?logo=openai&logoColor=white)](https://platform.openai.com/docs/api-reference)
[![Tests Passing](https://img.shields.io/badge/tests-95%2F95%20passing-brightgreen.svg)](cloudflare-worker/tests/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[English](#-english) | [ภาษาไทย](#-ภาษาไทย) | [简体中文](#-简体中文)

</div>

---

## 🌐 English

**Gemini Web Bridge (v4.3.4)** is an Enterprise-grade Edge AI Gateway and Chrome Extension that bridges live, authenticated [Google Gemini](https://gemini.google.com) web sessions into an **OpenAI-Compatible REST API** (with real SSE streaming & tool emulation) and a **Remote MCP Server**, powered by **Cloudflare Durable Objects**.

It enables autonomous AI clients and developer tools — **Hermes Agent**, **Cursor**, **Cline**, **Claude Code**, and Python/TypeScript SDKs — to harness Gemini's Deep Thinking models and execute Agentic Tool Loops directly over authenticated web sessions without artificial mocks or canned responses.

### ✨ Key Features

- **Cloudflare Durable Objects Hub (`GeminiBridgeDO`)** — Stateful in-memory Edge coordinator synchronizing browser WebSockets and external REST/MCP requests with FIFO concurrency control (concurrency = 1, queue depth = 10).
- **Dynamic Browser Model Sync** — Real-time model catalog synchronization (`/v1/models`) detecting live Gemini UI model tiers with verification lifecycle tracking (`discovered` → `learning` → `verified`).
- **Real SSE Streaming & Idle Timeout** — Immediate token chunk dispatching with an idle-based 60-second timeout, preventing long-thought dropouts.
- **Disconnect Grace Period (~15s)** — Connection buffering in Durable Objects ensuring network hiccups or browser tab backgrounding do not abort in-flight generations.
- **Conversation Scopes (Gemini App + NotebookLM)** — Seamless context routing between standard chat (`https://gemini.google.com/app/<id>`) and document-grounded NotebookLM notebooks (`https://gemini.google.com/notebook/<id>`) via the `set_bridge_scope` MCP tool.
- **Zero-Token-Leak Privacy (G1 Guardrail)** — Google CSRF tokens (`SNlM0e`) remain strictly in volatile browser MAIN-world RAM; credentials are never transmitted over the wire to Cloudflare Workers or external clients.
- **Strict Fail-Closed Architecture** — Responds with HTTP 503 / 422 immediately if the browser extension disconnects or a model is unverified. Zero mocks in production.

### 🚀 Quickstart

#### 1. Deploy the Cloudflare Worker

```bash
cd cloudflare-worker
npm install
npx wrangler deploy
```

Configure required secrets:

```bash
npx wrangler secret put BRIDGE_AUTH_TOKEN
npx wrangler secret put CLIENT_API_TOKEN
npx wrangler secret put GEMINI_API_KEY      # Optional: For GCP Hybrid Fallback
```

#### 2. Install the Chrome Extension

1. Open `chrome://extensions/` in Google Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select `gemini-web-bridge/extension-cloudflare`.
4. Open [https://gemini.google.com](https://gemini.google.com) and log in.
5. Inspect the background console or popup to confirm `Bridge: Connected`.

#### 3. Connect an AI Client

**Hermes Agent Configuration (`config.yaml`):**

```yaml
model:
  default: gemini-web-thinking
  provider: gemini-web-bridge
  base_url: https://gemini-web-bridge.pansakorn-pho.workers.dev/v1
  api_key: ${CLIENT_API_TOKEN}

providers:
  gemini-web-bridge:
    type: custom
    name: gemini-web-bridge
    base_url: https://gemini-web-bridge.pansakorn-pho.workers.dev/v1
    api_key: ${CLIENT_API_TOKEN}

mcp_servers:
  gemini-web-bridge:
    url: https://gemini-web-bridge.pansakorn-pho.workers.dev/mcp
    headers:
      Authorization: "Bearer ${CLIENT_API_TOKEN}"
```

**Python (OpenAI SDK):**

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://gemini-web-bridge.pansakorn-pho.workers.dev/v1",
    api_key="YOUR_CLIENT_API_TOKEN",
)

response = client.chat.completions.create(
    model="gemini-web-thinking",
    messages=[{"role": "user", "content": "Explain Cloudflare Durable Objects"}],
    stream=True,
)

for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

---

## 🌐 ภาษาไทย

**Gemini Web Bridge (v4.3.4)** คือ Edge AI Gateway และ Chrome Extension ระดับโปรดักชัน ที่ทำหน้าที่เป็นสะพานเชื่อมต่อเซสชันเว็บจริงของ [Google Gemini](https://gemini.google.com) เข้าสู่ **OpenAI-Compatible REST API** (รองรับ Real SSE Streaming & Tool Emulation) และ **Remote MCP Server** ผ่านขุมพลัง **Cloudflare Durable Objects**

ระบบนี้ออกแบบมาเพื่อให้นักพัฒนาและ AI Agent ภายนอก เช่น **Hermes Agent**, **Cursor**, **Cline**, **Claude Code** สามารถดึงศักยภาพโมเดล Deep Thinking และรัน Agentic Tool Loops บนเบราว์เซอร์จริงได้อย่างเต็มประสิทธิภาพ โดยไม่มีการจำลองคำตอบหลอก (Zero Mocks)

### ✨ จุดเด่นที่สำคัญ

- **ศูนย์กลาง Cloudflare Durable Objects (`GeminiBridgeDO`)** — ซิงโครไนซ์การทำงานระหว่าง WebSocket จากเบราว์เซอร์และ REST/MCP API บน Cloudflare Edge พร้อมระบบคิวงาน FIFO (Concurrency = 1, Max Waiters = 10)
- **Dynamic Browser Model Sync** — สแกนและตรวจจับรายชื่อโมเดลจริงจากหน้าเว็บ Gemini (`/v1/models`) แบบเรียลไทม์ พร้อมระบบตรวจสอบความถูกต้องของโครงสร้าง Payload (`discovered` → `learning` → `verified`)
- **Real SSE Streaming & Idle Timeout** — ส่งต่อโทเค็นคำตอบออกทันทีแบบ Chunk-by-Chunk ควบคู่กับ Idle Timeout 60 วินาที ป้องกันการตัดสายระหว่างที่โมเดลกำลังใช้ความคิดเชิงลึก (Deep Thinking)
- **Disconnect Grace Period (~15 วินาที)** — ระบบบัฟเฟอร์การเชื่อมต่อใน Durable Objects หากเครือข่ายกระตุกหรือ Chrome สลับแท็บไปเบื้องหลัง การสร้างคำตอบจะไม่ถูกยกเลิกกะทันหัน
- **Conversation Scopes (Gemini App + NotebookLM)** — สลับบริบทการสนทนาระหว่างแชตทั่วไป (`https://gemini.google.com/app/<id>`) และคลังเอกสารเฉพาะทางบน NotebookLM (`https://gemini.google.com/notebook/<id>`) ผ่าน MCP Tool `set_bridge_scope`
- **ความปลอดภัยระดับสูงสุด (Zero-Token-Leak - กฎเหล็ก G1)** — CSRF Token ของ Google (`SNlM0e`) ถูกเก็บรักษาไว้ในหน่วยความจำ RAM ของ MAIN-world ในเบราว์เซอร์เท่านั้น และจะไม่มีการส่งออกนอกเครื่องเด็ดขาด
- **สถาปัตยกรรม Fail-Closed เคร่งครัด** — ส่งคืน HTTP 503 หรือ 422 ทันทีหาก Extension ขาดการเชื่อมต่อหรือโมเดลยังไม่ได้รับการรับรอง

### 🚀 การเริ่มต้นใช้งานอย่างรวดเร็ว

#### 1. Deploy Cloudflare Worker

```bash
cd cloudflare-worker
npm install
npx wrangler deploy
```

ตั้งค่า Environment Secrets:

```bash
npx wrangler secret put BRIDGE_AUTH_TOKEN
npx wrangler secret put CLIENT_API_TOKEN
npx wrangler secret put GEMINI_API_KEY      # ทางเลือก: สำหรับ GCP Hybrid Fallback
```

#### 2. ติดตั้ง Chrome Extension

1. เปิด `chrome://extensions/` ใน Google Chrome
2. เปิดสวิตช์ **Developer mode (โหมดนักพัฒนา)** ที่มุมขวาบน
3. คลิก **Load unpacked** แล้วเลือกโฟลเดอร์ `gemini-web-bridge/extension-cloudflare`
4. เปิดหน้าเว็บ [https://gemini.google.com](https://gemini.google.com) และล็อกอินบัญชี Google ให้เรียบร้อย
5. ตรวจสอบสถานะการเชื่อมต่อที่มุมขวาล่างหรือหน้าต่าง Options จะแสดง `Bridge: Connected`

#### 3. ตรวจสอบสุขภาพระบบ

```bash
curl -s https://gemini-web-bridge.pansakorn-pho.workers.dev/health | jq .
```

---

## 🌐 简体中文

**Gemini Web Bridge (v4.3.4)** 是一个企业级 Edge AI 网关和 Chrome 扩展程序。它基于 **Cloudflare Durable Objects** 构建，将真实的、已认证的 [Google Gemini](https://gemini.google.com) 网页会话桥接为 **兼容 OpenAI 的 REST API**（支持真正的 SSE 流式传输和工具仿真）以及 **远程 MCP 服务器**。

它支持外部 AI Agent 与开发工具（如 **Hermes Agent**、**Cursor**、**Cline**、**Claude Code**、Python/TS SDK）直接在真实网页会话上调用 Deep Thinking 深度思考模型并执行自主工具循环（Agentic Tool Loops），杜绝任何伪造或 Mock 数据。

### ✨ 核心亮点

- **Cloudflare Durable Objects 状态中枢 (`GeminiBridgeDO`)** — 在 Edge 内存中无缝融合浏览器 WebSocket 与客户端 HTTP/REST 请求，具备 FIFO 队列机制与并发隔离保护。
- **浏览器模型动态同步** — 实时同步 Gemini 网页端可用的最新模型目录（`/v1/models`），并严格追踪模型验证状态生命周期（`discovered` → `learning` → `verified`）。
- **真正的 SSE 流式输出与空闲超时** — Token 块即时分发，配备基于 60 秒空闲的超时控制，适应复杂思维推理任务。
- **断线宽限期保护机制 (~15 秒)** — Durable Objects 提供短时重连缓冲，在网络波动或浏览器标签页休眠时保护处理中的请求不被中断。
- **对话作用域管理 (Gemini App 与 NotebookLM)** — 通过 MCP 工具 `set_bridge_scope` 支持在普通聊天与知识库 NotebookLM（`/notebook/<id>`）之间自由切换，精准把控上下文。
- **零令牌泄露隐私安全 (G1 准则)** — Google CSRF 凭证（`SNlM0e`）仅驻留在浏览器 MAIN 线程内存中，绝不经由网络上传输。
- **严格快速失败机制** — 当扩展离线或模型未经验证时，严格返回 HTTP 503 / 422，杜绝欺骗性 Mock 行为。

### 🚀 快速上手

#### 1. 部署 Cloudflare Worker

```bash
cd cloudflare-worker
npm install
npx wrangler deploy
```

配置必要密钥：

```bash
npx wrangler secret put BRIDGE_AUTH_TOKEN
npx wrangler secret put CLIENT_API_TOKEN
```

#### 2. 安装 Chrome 扩展

1. 在 Chrome 中打开 `chrome://extensions/`。
2. 开启右上角 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择目录 `gemini-web-bridge/extension-cloudflare`。
4. 访问 [https://gemini.google.com](https://gemini.google.com) 并登录 Google 账号。
5. 扩展将自动建立与 Edge Worker 的 WSS 连接。

---

## 🧰 Remote MCP Tools (Model Context Protocol)

Gemini Web Bridge provides a complete suite of remote MCP tools via `POST /mcp` conforming to the JSON-RPC 2.0 / MCP spec:

| Tool Name | Scope | Parameters | Description |
|:---|:---:|:---|:---|
| `set_bridge_scope` | Core | `scope` *(string)* | Switches bridge context between standard chat (`app`) and specific NotebookLM URLs (`notebook`). |
| `sdlc_solution_architect` | SDLC | `problem_description`, `scope?` | Generates system architecture, component models, data flows, and security roadmaps. |
| `orchestrate_sdlc_plan` | SDLC | `problem_description`, `scope?` | Creates end-to-end SDLC execution plans with test verification gates. |
| `code_review_and_debug` | SDLC | `problem_description`, `scope?` | In-depth code auditing, OWASP security vulnerability detection, and root-cause fix synthesis. |
| `evaluate_tech_tradeoffs` | SDLC | `problem_description`, `scope?` | Structured technology evaluation and weighted trade-off decision matrices. |
| `horo_consult` | Domain | `query`, `response_format?`, `birth_context?` | Domain intelligence tool with temporary KV PDF artifact delivery. |
| `ping` | System | `message?` | Checks hub health, extension connectivity, active scope, and latency. |
| `check_bridge_health` | Diagnostic | — | Detailed diagnostics on WebSocket status, consecutive errors, and GCP fallbacks. |
| `list_bridge_models` | Catalog | — | Live dynamic model catalog directly discovered from the active browser session. |

---

## 🏗️ Architecture Blueprint

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                   AI Clients Tier                                      │
│         Hermes Agent · Cursor · Cline · Claude Code · Python SDK · cURL Requests       │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │ HTTPS (Bearer Auth: CLIENT_API_TOKEN)
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                    Cloudflare Worker Edge Tier (gemini-web-bridge v4.3.4)              │
│                                                                                        │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │                         Edge Routing & Security Middleware                     │   │
│   │   • Bearer Token Authentication Validator                                      │   │
│   │   • Strict Fail-Fast Policy (503 on Offline, 422 on Unverified, Zero Mocks)    │   │
│   │   • Permissive CORS with Mcp-Session-Id and Mcp-Protocol-Version Headers       │   │
│   └──────┬────────────────────────┬────────────────────────┬───────────────────────┘   │
│          │                        │                        │                           │
│          ▼                        ▼                        ▼                           │
│   ┌──────────────┐         ┌──────────────┐         ┌──────────────┐                   │
│   │ OpenAI REST  │         │  Remote MCP  │         │  Status API  │                   │
│   │ /v1/*        │         │  /mcp        │         │  /health     │                   │
│   └──────┬───────┘         └──────┬───────┘         └──────┬───────┘                   │
│          │                        │                        │                           │
│          └────────────────────────┼────────────────────────┘                           │
│                                   ▼                                                    │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │                 GeminiBridgeDO (Stateful Durable Object Instance)              │   │
│   │   • Global Singleton (`idFromName("global-bridge")`)                           │   │
│   │   • FIFO Request Queue (Max 10 Waiters, Idle-Based 60s Timeout)                │   │
│   │   • Disconnect Grace Period (~15s Reconnection Buffer)                         │   │
│   │   • Real SSE Chunk Streaming (Immediate `STREAM_CHUNK` dispatch)               │   │
│   │   • Dynamic Model Catalog & Verification Registry (Dynamic Browser Sync)       │   │
│   │   • Conversation Scope Manager (Gemini App `/app/` & NotebookLM `/notebook/`)  │   │
│   └───────────────────────┬────────────────────────────────┬───────────────────────┘   │
│                           │ WebSocket (WSS Protocol v2)    │ Fallback on Offline       │
│                           ▼                                ▼                           │
│   ┌──────────────────────────────────────────────┐ ┌───────────────────────────────┐   │
│   │  Chrome Extension (Manifest V3 Background)   │ │  Google Cloud Platform (GCP)  │   │
│   │  • background.js (Socket Owner, Keep-Alive)  │ │  • Gemini 1.5/2.0 Flash/Pro   │   │
│   │  • top-level sync port coordinator           │ │  • Header:                    │   │
│   │  • active tab & scope navigator              │ │    X-Provider: gcp-fallback   │   │
│   └───────────────────────┬──────────────────────┘ └───────────────────────────────┘   │
└───────────────────────────┼────────────────────────────────────────────────────────────┘
                            │ chrome.runtime Port Connection
                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                       Google Chrome Tab Runtime (gemini.google.com)                    │
│   • content.js: Isolated World Scope Detector & SPA Polling (3s interval)              │
│   • injected.js: MAIN World Zero-Leak CSRF Token Vault (`SNlM0e` in RAM only)          │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---
<div align="center">

### 🤝 Let's Connect & Build High-Impact AI Systems Together!

[![LinkedIn Profile](https://img.shields.io/badge/LinkedIn-Pansakorn%20Phothidaen-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/pansakorn/)
[![GitHub Profile](https://img.shields.io/badge/GitHub-pphothidaen-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/pphothidaen)
[![Hugging Face Profile](https://img.shields.io/badge/HuggingFace-pphothidaen-181717?style=for-the-badge&logo=huggingface&logoColor=white)](https://huggingface.co/pphothidaen)

</div>

---

## 📄 License

MIT License — Released for open research, learning, and enterprise AI enablement.
