Project Idea & Architecture Specification: Gemini Web Bridge
1. Executive Summary & Vision (วิสัยทัศน์ของโครงการ)
Gemini Web Bridge คือระบบเกตเวย์และสะพานเชื่อมต่ออัจฉริยะ (Edge AI Gateway) ที่พัฒนาขึ้นเพื่อแปลงเซสชันการทำงานของ Google Gemini (ผ่าน Chrome Extension) และ Gemini API ให้กลายเป็น Remote Model Context Protocol (MCP) Server และ OpenAI-Compatible REST API บนโครงสร้างพื้นฐานระดับโลกของ Cloudflare Workers
เป้าหมายหลักคือการเปิดให้ AI Agent ภายนอก เช่น Hermes Agent (Nous Research), Gemini Spark Custom Apps, และเครื่องมือช่วยเขียนโค้ด (Cursor, Claude Code, Cline) สามารถเชื่อมต่อเข้ามาดึงศักยภาพการคิดวิเคราะห์เชิงลึกของ Gemini ไปทำหน้าที่เป็น Principal Software Architect & SDLC Orchestration Agent ได้อย่างปลอดภัยและมีความพร้อมใช้งานสูง (High Availability)

2. Problem Statement (ปัญหาที่โครงการเข้ามาแก้ไข)
ข้อจำกัดของ Localhost Proxy: ระบบเชื่อมต่อเว็บเซสชันเดิมจำเป็นต้องรันบน 127.0.0.1:8790 ทำให้ Agent ภายนอกหรือระบบบนคลาวด์ไม่สามารถเข้าถึงได้
ความเสี่ยงเรื่อง Session หลุดและ Error 503: หาก Extension ออฟไลน์ หรือการเชื่อมต่อตกค้าง การส่งคำขอจะล้มเหลวทันที
การถูกสกัดกั้นด้วยนโยบายความปลอดภัยของเบราว์เซอร์ (CSP): หน้าเว็บ gemini.google.com มีการบังคับใช้ Content Security Policy ที่เข้มงวด ทำให้สคริปต์หน้าเว็บทั่วไปไม่สามารถเปิดการเชื่อมต่อ WebSocket ออกไปยังคลาวด์ได้โดยตรง
ความต้องการระบบ Authentication & Authorization ที่รัดกุม: ป้องกันการสวมรอยเข้าถึงเซสชันของผู้ใช้จากภายนอก

3. Architecture & Key Innovations (สถาปัตยกรรมและนวัตกรรมหลัก)
3.1 สถาปัตยกรรม Cloudflare Durable Objects & Protocol v2 (v4.2.0)

┌────────────────────────────────────────────────────────────────────┐
│                        Clients (HTTPS)                             │
│  Hermes Agent ──── OpenAI API (/v1) ───── Bearer Token Auth        │
│  Hermes Tools ──── OpenAI Tools ───────── Tool Emulation Loop      │
│  Gemini Spark ──── Remote MCP (/mcp) ──── Bearer Token Auth        │
│  Cursor / Cline ── OpenAI API (/v1) ───── Bearer Token Auth        │
│  Claude Code ───── MCP (/mcp) ─────────── Bearer Token Auth        │
└───────────────────────────┬────────────────────────────────────────┘
                            │ (HTTPS + SSE Streaming)
                            ▼
┌────────────────────────────────────────────────────────────────────┐
│         Cloudflare Worker (gemini-web-bridge: GeminiBridgeDO)      │
│                                                                    │
│  Endpoints:                                                        │
│  ├─ /bridge ─── WSS Protocol v2 Stateful Hub (Durable Object RAM)  │
│  ├─ /mcp ────── Remote MCP Gateway (JSON-RPC 2.0)                  │
│  ├─ /v1 ─────── OpenAI-Compatible REST API + SSE Streaming         │
│  ├─ /v1/models  Dynamic Model Catalog Sync & Recommendations       │
│  └─ / ────────── Status Dashboard (Public Health Check)            │
│                                                                    │
│  Security: Bearer Token (CLIENT_API_KEY) + BRIDGE_SECRET           │
│  Engine:   Durable Objects RAM Coordination + Strict Fail-Fast     │
└─────────────┬──────────────────────────────────────────────────────┘
              │ (WSS Protocol v2: Dedicated-Tab Leader)
              ▼
┌────────────────────────────────────────────────────────────────────┐
│ Chrome Extension (Protocol v2 — Manifest V3)                       │
│ ├─ background.js (Centralized Dedicated-Tab Coordinator)           │
│ ├─ content.js (Isolated World: Relay, UI Model Selection)          │
│ ├─ injected.js (MAIN World: Native RPC Interceptor, Zero CSRF Leak)│
│ ├─ model-adapter.js (Verified Replay Payload Construction)         │
│ └─ evidence-registry.js (Session Epoch Invalidation, Fail-Closed)  │
└─────────────┬──────────────────────────────────────────────────────┘
              │ (First-Party Cookies + Native Session RPC)
              ▼
┌────────────────────────────────────────────────────────────────────┐
│ Active Gemini Web Session (https://gemini.google.com/)             │
└────────────────────────────────────────────────────────────────────┘

3.2 Transport Protocol Summary

Extension ↔ Worker:
  - WSS (WebSocket Secure) ผ่าน wss://gemini-web-bridge.pphothidaen.workers.dev/bridge
  - ใช้ content.js ใน Isolated World สร้าง WebSocket connection
  - ข้าม CSP ได้เนื่องจาก content script อยู่ใน Extension context ไม่อยู่ภายใต้ CSP ของหน้าเว็บ
  - Reconnect อัตโนมัติด้วย Exponential Backoff (1s → 30s cap)
  - Keepalive ด้วย PING/PONG ทุก 15 วินาที

Clients ↔ Worker:
  - HTTPS REST API (OpenAI-Compatible /v1/chat/completions)
  - HTTPS JSON-RPC (MCP Protocol /mcp)
  - SSE Streaming สำหรับ real-time response (stream: true)
  - Bearer Token Authentication ทุก request

3.3 Data Flow (การไหลของข้อมูล)

[Client Request] → HTTPS → [Worker /v1 or /mcp]
  → Worker ตรวจ Bearer Token
  → Worker ส่ง EXECUTE_REQUEST ผ่าน WSS → [content.js]
  → content.js relay เป็น EXECUTE_STREAM → [injected.js]
  → injected.js ใช้ First-Party Session fetch() → [Gemini Backend]
  → Gemini Backend ตอบกลับ Stream → [injected.js]
  → injected.js ส่ง STREAM_CHUNK กลับ → [content.js]
  → content.js relay ผ่าน WSS → [Worker]
  → Worker ส่ง SSE chunks กลับ → [Client]

3.4 ระบบรักษาความปลอดภัยแบบหลายชั้น (Multi-Tier Security)
Extension Level: ตรวจสอบสิทธิ์ผ่าน BRIDGE_SECRET ก่อนอนุญาต WebSocket connection
Client Level: ป้องกันการเรียกใช้งาน API และ MCP ด้วย Bearer Token (CLIENT_API_KEY) ในทุก request
Transport Level: WSS (TLS encrypted) สำหรับ Extension, HTTPS สำหรับ Clients

4. Feature Matrix & Toolsets (ชุดฟังก์ชันการทำงาน)
4.1 เครื่องมือเฉพาะทางด้าน Coding & SDLC Orchestration
sdlc_solution_architect: วิเคราะห์ปัญหา ออกแบบ System Architecture, Component Model, Data Flow และ Implementation Roadmap
orchestrate_sdlc_plan: วางแผนขั้นตอน SDLC แตก Task ย่อยอย่างละเอียด (Planning, Architecture, Implementation, QA, Release)
code_review_and_debug: ตรวจหาสาเหตุของ Bug (Root Cause Analysis), ตรวจสอบช่องโหว่ความปลอดภัย และสร้าง Code Patch
evaluate_tech_tradeoffs: วิเคราะห์เปรียบเทียบทางเลือกเทคโนโลยี (Trade-off Matrix) เชิงลึก
ping: ตรวจสอบสถานะการเชื่อมต่อระหว่าง Cloud Hub และ Chrome Extension

4.2 มาตรฐานโปรโตคอลที่รองรับ
Model Context Protocol (MCP): รองรับ Streamable HTTP Transport (JSON-RPC 2.0 over HTTPS)
OpenAI API Standard: รองรับโมเดล gemini-web และ gemini-web-thinking ทั้งแบบ JSON Response ปกติ และ Real-time SSE Streaming (data: [DONE])

4.3 Client Compatibility Matrix
┌──────────────────┬───────────────┬─────────────────┬────────────────────┐
│ Client           │ Protocol      │ Endpoint         │ Features           │
├──────────────────┼───────────────┼─────────────────┼────────────────────┤
│ Hermes Agent     │ OpenAI API    │ /v1              │ Chat + SSE Stream  │
│                  │ MCP           │ /mcp             │ Tools (5 tools)    │
├──────────────────┼───────────────┼─────────────────┼────────────────────┤
│ Gemini Spark     │ MCP           │ /mcp             │ Custom App Tools   │
├──────────────────┼───────────────┼─────────────────┼────────────────────┤
│ Cursor           │ OpenAI API    │ /v1              │ Multi-turn + SSE   │
├──────────────────┼───────────────┼─────────────────┼────────────────────┤
│ Claude Code      │ MCP           │ /mcp             │ Tools + Session    │
├──────────────────┼───────────────┼─────────────────┼────────────────────┤
│ Cline            │ OpenAI API    │ /v1              │ Multi-turn + SSE   │
└──────────────────┴───────────────┴─────────────────┴────────────────────┘

5. Deployment & Ecosystem Integration (การนำไปใช้งานจริง) [STATUS: ✅ VERIFIED]

5.1 Gemini Spark
ติดตั้งในฐานะ Custom App (@geminiwebbridge) ผ่าน Remote MCP URL:
  URL: https://gemini-web-bridge.pphothidaen.workers.dev/mcp
  Auth: Bearer Token (REPLACE_WITH_GITHUB_SECRET_CLIENT_API_TOKEN)

5.2 Hermes Agent (Nous Research) — [✅ PRODUCTION READY]
ตั้งค่าใน ~/.hermes/config.yaml และทดสอบรันสำเร็จ:
  model:
    default: gemini-web-thinking
    provider: gemini-web-bridge
    base_url: https://gemini-web-bridge.pphothidaen.workers.dev/v1
    api_key: REPLACE_WITH_GITHUB_SECRET_CLIENT_API_TOKEN
  mcp_servers:
    gemini-web-bridge:
      url: https://gemini-web-bridge.pphothidaen.workers.dev/mcp
      headers:
        Authorization: "Bearer REPLACE_WITH_GITHUB_SECRET_CLIENT_API_TOKEN"

5.3 Cursor / Cline
ตั้งค่าใน Settings → Models:
  Base URL: https://gemini-web-bridge.pphothidaen.workers.dev/v1
  API Key: <CLIENT_API_KEY>
  Model: gemini-web-thinking

5.4 Claude Code
ตั้งค่าใน MCP config:
  {
    "mcpServers": {
      "gemini-web-bridge": {
        "url": "https://gemini-web-bridge.pphothidaen.workers.dev/mcp",
        "headers": { "Authorization": "Bearer <CLIENT_API_KEY>" }
      }
    }
  }

5.5 Chrome Extension (v3.0)
ติดตั้งผ่าน Chrome Developer Mode:
  1. chrome://extensions/ → Developer Mode ON
  2. Load unpacked → เลือกโฟลเดอร์ extension-cloudflare/
  3. เปิด gemini.google.com → Extension เชื่อมต่อ WSS อัตโนมัติ
  4. ตั้งค่า Worker URL และ Token ผ่าน Options Page

6. Future Roadmap (แผนการพัฒนาต่อยอด)
Multi-Session Load Balancing: รองรับการเชื่อมต่อ Chrome Extension จากหลายเครื่องพร้อมกันเพื่อกระจายโหลด
Context Persistence & Vector Memory: เพิ่มระบบความจำระยะยาวผ่าน Cloudflare Vectorize / D1 Database
Automated Session Health Recovery: ระบบตรวจจับเซสชันหมดอายุอัตโนมัติพร้อมแจ้งเตือนผู้ใช้งานผ่าน Webhook
