# ⚡ Gemini Web Bridge

<div align="center">

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20Durable%20Objects-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension%20MV3%20Protocol%20v2-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![MCP Protocol](https://img.shields.io/badge/MCP-2024--11--05-8A2BE2)](https://modelcontextprotocol.io/)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-412991?logo=openai&logoColor=white)](https://platform.openai.com/docs/api-reference)
[![Stars](https://img.shields.io/github/stars/pphothidaen/gemini-web-bridge?style=social)](https://github.com/pphothidaen/gemini-web-bridge/stargazers)
[![Forks](https://img.shields.io/github/forks/pphothidaen/gemini-web-bridge?style=social)](https://github.com/pphothidaen/gemini-web-bridge/network/members)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[English](#english) | [ไทย](#ไทย) | [简体中文](#简体中文)

</div>

---

## 🌐 English

**Gemini Web Bridge (v4.3.4)** is an Edge AI Gateway and Chrome Extension that bridges real [Google Gemini](https://gemini.google.com) web sessions into an **OpenAI-Compatible REST API** (with SSE Streaming & Tool Emulation) and a **Remote MCP Server**, powered by **Cloudflare Durable Objects**.

It lets external AI Agents — **Hermes Agent**, **Cursor**, **Cline**, **Claude Code** — call Deep Thinking and run Agentic Tool Loops on a real Gemini web session: no mocks, no canned responses.

### ✨ Highlights

- **Cloudflare Durable Objects Hub** — Stateful in-memory coordination (`GeminiBridgeDO`) fusing browser WebSocket and AI client HTTP/REST into one Cloudflare Edge RAM with FIFO queueing and isolation.
- **Dynamic Browser Model Sync** — Real-time model list / catalog sync from the Gemini web UI (`/v1/models`) with per-model verification state (`discovered`, `learning`, `verified`, `stale`, `unsupported`).
- **OpenAI Tool Emulation** — Converts tool schemas to prompt directives and decodes Gemini responses into OpenAI SSE `tool_calls` chunks (supports `terminal`, `git`, `read_file`, `write_file`, custom tools).
- **Protocol v2 Chrome Extension** — Dedicated-tabs coordinator, automatic leader-tab election, instant failover.
- **Privacy-first security** — Google CSRF (`SNlM0e`) never leaves the browser MAIN-world memory; sent to Worker over WSS is prohibited.
- **Strict fail-fast** — HTTP 503 / 422 if the extension is offline or the model is not verified. No fake/mock behavior.
- **SSE streaming + Remote MCP** — Standard OpenAI streaming and JSON-RPC 2.0 MCP tools.

### 🚀 Quickstart

#### 1. Deploy the Worker

```bash
cd cloudflare-worker
npm install
npx wrangler deploy
```

Set secrets before deploying:

```bash
npx wrangler secret put BRIDGE_AUTH_TOKEN
npx wrangler secret put CLIENT_API_TOKEN
```

#### 2. Install the Chrome Extension

1. Open `chrome://extensions/` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select `gemini-web-bridge/extension-cloudflare`.
4. Open [https://gemini.google.com](https://gemini.google.com) and sign in to your Google account.
5. Open DevTools (F12) — you should see:

```text
[Bridge] 🔌 Connecting to Worker: wss://gemini-web-bridge.../bridge
[Bridge] ✅ Bridge Connected Successfully
[Bridge] ✅ Session Ready: Tokens synchronized
```

#### 3. Connect an AI Client

Use the same `CLIENT_API_TOKEN` configured in GitHub Secrets or Doppler. Never commit real secrets.

**Hermes Agent:**

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

**Python OpenAI SDK:**

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://gemini-web-bridge.pansakorn-pho.workers.dev/v1",
    api_key="YOUR_CLIENT_API_TOKEN",
)
```

### 🔍 Verify

```bash
curl -s https://gemini-web-bridge.pansakorn-pho.workers.dev/ | jq
```

Optional local secret loading:

```bash
cd ~/Project/gemini-web-bridge
doppler secrets download --project gemini-web-bridge --config prd_worker --format env --no-file > .env
```

---

## 🌐 ไทย

**Gemini Web Bridge (v4.3.4)** คือ Edge AI Gateway และ Chrome Extension ที่เชื่อมต่อเซสชัน [Google Gemini](https://gemini.google.com) จริงเข้าสู่ **OpenAI-Compatible REST API** (พร้อม SSE Streaming & Tool Emulation) และ **Remote MCP Server** ผ่าน **Cloudflare Durable Objects**

ระบบนี้ช่วยให้ AI Agent ภายนอก เช่น **Hermes Agent**, **Cursor**, **Cline**, **Claude Code** สามารถใช้ Deep Thinking และ Agentic Tool Loops บนเซสชัน Gemini Web จริง 100% โดยไม่มีการ Mock หลอก

### ✨ จุดเด่น

- **Cloudflare Durable Objects Hub** — ประสานงาน WebSocket จากเบราว์เซอร์และ HTTP/REST จาก AI Client เข้าใน RAM เดียวกันบน Cloudflare Edge พร้อม FIFO queueing และ isolation
- **Dynamic Browser Model Sync** — ซิงก์โมเดลจริงจาก Gemini web UI แบบ real-time ผ่าน `/v1/models` พร้อมสถานะตรวจสอบรายโมเดล
- **OpenAI Tool Emulation** — แปลง Tool schemas เป็น prompt directives และถอดรหัสกลับเป็น OpenAI SSE `tool_calls` chunks
- **Chrome Extension Protocol v2** — Dedicated-Tab Coordinator เลือก leader tab อัตโนมัติ และมี failover ทันที
- **ความปลอดภัยแบบ privacy-first** — CSRF token (`SNlM0e`) ไม่ถูกส่งออกจาก browser MAIN-world memory
- **Fail-fast เข้มงวด** — ตอบ HTTP 503 / 422 ทันทีหาก extension offline หรือโมเดลยังไม่ verified

### 🚀 เริ่มต้นใช้งาน

#### 1. Deploy Worker

```bash
cd cloudflare-worker
npm install
npx wrangler deploy
```

ตั้งค่า secret ก่อน deploy:

```bash
npx wrangler secret put BRIDGE_AUTH_TOKEN
npx wrangler secret put CLIENT_API_TOKEN
```

#### 2. ติดตั้ง Chrome Extension

1. เปิด `chrome://extensions/` ใน Chrome
2. เปิด **Developer mode**
3. กด **Load unpacked** แล้วเลือกโฟลเดอร์ `gemini-web-bridge/extension-cloudflare`
4. เปิด [https://gemini.google.com](https://gemini.google.com) แล้วล็อกอินบัญชี Google
5. เปิด DevTools (F12) จะเห็น:

```text
[Bridge] 🔌 Connecting to Worker: wss://gemini-web-bridge.../bridge
[Bridge] ✅ Bridge Connected Successfully
[Bridge] ✅ Session Ready: Tokens synchronized
```

#### 3. เชื่อมต่อ Client

ใช้ `CLIENT_API_TOKEN` เดียวกันกับ GitHub Secrets หรือ Doppler อย่าทำ secret จริงขึ้น repo

**Hermes Agent:**

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

**Python:**

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://gemini-web-bridge.pansakorn-pho.workers.dev/v1",
    api_key="YOUR_CLIENT_API_TOKEN",
)
```

### 🔍 ตรวจสอบ

```bash
curl -s https://gemini-web-bridge.pansakorn-pho.workers.dev/ | jq
```

โหลด secret สำหรับ local dev (ใช้ Doppler):

```bash
cd ~/Project/gemini-web-bridge
doppler secrets download --project gemini-web-bridge --config prd_worker --format env --no-file > .env
```

---

## 🌐 简体中文

**Gemini Web Bridge (v4.3.4)** 是一个 Edge AI 网关和 Chrome 扩展，通过 **Cloudflare Durable Objects** 将真实的 [Google Gemini](https://gemini.google.com) 网页会话桥接到 **OpenAI 兼容 REST API**（支持 SSE 流式传输和工具仿真）以及 **远程 MCP 服务器**。

它让外部 AI Agent（如 **Hermes Agent**、**Cursor**、**Cline**、**Claude Code**）能够在真实的 Gemini 网页会话上调用深度思考（Deep Thinking）并运行 Agentic Tool Loop：无 mock、无伪造响应。

### ✨ 主要特性

- **Cloudflare Durable Objects Hub** — 有状态内存协调（`GeminiBridgeDO`），将浏览器 WebSocket 与 AI 客户端 HTTP/REST 融合到同一个 Cloudflare Edge RAM 中，支持 FIFO 队列和隔离。
- **动态浏览器模型同步** — 通过 `/v1/models` 实时同步 Gemini 网页端的模型目录，含逐模型验证状态（`discovered`、`learning`、`verified`、`stale`、`unsupported`）。
- **OpenAI 工具仿真** — 将工具 Schema 转换为提示指令，并将 Gemini 响应解码为 OpenAI SSE `tool_calls` 数据块。
- **Chrome 扩展 Protocol v2** — 专用标签页协调器，自动选举 Leader Tab，即时故障转移。
- **隐私优先安全** — Google CSRF token（`SNlM0e`）不会离开浏览器 MAIN-world 内存。
- **严格快速失败** — 扩展离线或模型未验证时立即返回 HTTP 503 / 422。

### 🚀 快速开始

#### 1. 部署 Worker

```bash
cd cloudflare-worker
npm install
npx wrangler deploy
```

部署前设置密钥：

```bash
npx wrangler secret put BRIDGE_AUTH_TOKEN
npx wrangler secret put CLIENT_API_TOKEN
```

#### 2. 安装 Chrome 扩展

1. 在 Chrome 中打开 `chrome://extensions/`
2. 启用 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择 `gemini-web-bridge/extension-cloudflare`
4. 打开 [https://gemini.google.com](https://gemini.google.com) 并登录 Google 账号
5. 打开 DevTools (F12)，您将看到：

```text
[Bridge] 🔌 Connecting to Worker: wss://gemini-web-bridge.../bridge
[Bridge] ✅ Bridge Connected Successfully
[Bridge] ✅ Session Ready: Tokens synchronized
```

#### 3. 连接 AI 客户端

请使用与 GitHub Secrets 或 Doppler 中相同的 `CLIENT_API_TOKEN`，不要将密钥提交到代码仓库。

**Hermes Agent：**

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

**Python OpenAI SDK：**

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://gemini-web-bridge.pansakorn-pho.workers.dev/v1",
    api_key="YOUR_CLIENT_API_TOKEN",
)
```

### 🔍 验证部署

```bash
curl -s https://gemini-web-bridge.pansakorn-pho.workers.dev/ | jq
```

本地开发可加载 Doppler 密钥：

```bash
cd ~/Project/gemini-web-bridge
doppler secrets download --project gemini-web-bridge --config prd_worker --format env --no-file > .env
```

---

## 🧰 MCP Tools

| Tool | Description |
|:---|:---|
| `sdlc_solution_architect` | Analyze problems and design system architecture, component model, data flow, and implementation roadmap. |
| `orchestrate_sdlc_plan` | Create SDLC roadmaps and break them into actionable tasks across Plan → Arch → Code → Test → Deploy. |
| `code_review_and_debug` | Review code, find root causes, recommend patches, and audit security risks. |
| `evaluate_tech_tradeoffs` | Compare technology choices with a structured trade-off matrix. |
| `ping` | Check Cloud Hub, Chrome Extension, and Engine Mode connectivity. |

---

## 🏗️ Architecture

```text
┌────────────────────────────────────────────────────────────┐
│                      AI Clients                             │
│  Hermes Agent • Cursor • Cline • Claude Code                │
└───────────────────────────┬────────────────────────────────┘
                            │ HTTPS / WSS
                            ▼
┌────────────────────────────────────────────────────────────┐
│          Cloudflare Worker (Durable Objects)               │
│  GET  /                    Health & status                 │
│  POST /v1/chat/completions Chat Completions (SSE)          │
│  GET  /v1/models           Dynamic model catalog           │
│  POST /mcp                 MCP JSON-RPC 2.0                │
│  GET  /bridge              WSS Hub                         │
│                                                            │
│  GeminiBridgeDO:                                           │
│  • WebSocket ↔ HTTP request coordination                   │
│  • Dynamic model catalog                                   │
│  • Tool emulation engine                                   │
│  • FIFO request queue                                      │
│  • Strict fail-fast validation                             │
└───────────────────────────┬────────────────────────────────┘
                            │ WSS Protocol v2
                            ▼
┌────────────────────────────────────────────────────────────┐
│ Chrome Extension (Manifest V3, Protocol v2)                 │
│  background.js  content.js  injected.js                     │
│  model-adapter.js  evidence-registry.js                     │
└───────────────────────────┬────────────────────────────────┘
                            │ First-party browser session
                            ▼
┌────────────────────────────────────────────────────────────┐
│ Google Gemini Web Session                                  │
└────────────────────────────────────────────────────────────┘
```

---

## 🧑‍💻 About the Author

**Pansakorn Phothidaen** — Software Engineer & AI Systems Builder.

I work at the intersection of **Cloudflare Edge AI**, **Durable Objects**, **AI Agent tooling**, and **HR + Technology enablement**. I enjoy building production-grade AI infrastructure and open-source tools that let developers work smarter.

- 💼 LinkedIn: [linkedin.com/in/pansakorn](https://www.linkedin.com/in/pansakorn/)
- 🐙 GitHub: [github.com/pphothidaen](https://github.com/pphothidaen)
- 📬 Contact: Reach out on LinkedIn for collaboration or consulting.

If this project helps you build faster or learn something new, please consider:

- ⭐ **Starring** this repository to help others discover it
- 🍴 **Forking** it to build your own Gemini Web bridge or MCP gateway
- 💬 Opening an issue to suggest a feature or improvement

Your support helps me continue building open-source tools for the community.

---

## 🤝 Contributing

Contributions are welcome. Please open an issue or pull request. Make sure tests pass:

```bash
cd cloudflare-worker
npm install
node --test tests/
```

For production deployment secrets, use GitHub Actions Secrets or Doppler. Do not commit real credentials.

---

## 📄 License

MIT License.-released for learning, research, and enterprise AI integration.
