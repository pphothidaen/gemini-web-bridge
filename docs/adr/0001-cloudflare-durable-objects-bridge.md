# ADR-001: Cloudflare Durable Objects Bridge Architecture

## Metadata
- **Status:** Accepted
- **Date:** 2026-11-13
- **Author:** Hermes Agent / Kim Leng Lim
- **Ticket:** KAN-236 (Release 4.7.39)
- **Supersedes:** None (initial architecture)

## Context
Gemini Web Bridge ต้องการสร้าง Edge-to-Browser Gateway ที่เชื่อมต่อ AI Clients (Hermes Agent, Cursor, Cline, Claude Code, Python SDK) เข้ากับ Google Gemini Web Session จริง โดยไม่ต้องใช้ mock หรือ canned responses ระบบต้องรองรับ:
- Real SSE streaming จาก Gemini web session
- WebSocket connection ระหว่าง Cloudflare Worker และ Chrome Extension
- State management แบบ real-time สำหรับ active socket และ model catalog
- Zero-token-leak privacy (CSRF token ต้องอยู่ใน browser MAIN world เท่านั้น)

## Decision
ใช้ **Cloudflare Durable Objects** (`GeminiBridgeDO`) เป็น single-instance state coordinator บน Cloudflare Edge โดยมีลักษณะดังนี้:

1. **Single Instance Pattern:** ใช้ `idFromName("global-bridge")` เพื่อให้มี DO instance เดียวทั่วโลก ซึ่งทำให้ state consistency ง่ายและไม่มี race condition
2. **In-Memory State:** `activeSocket` (1 WebSocket connection), `FIFO Queue` (max 10 waiters, 60s deadline), `Model Catalog` (in-memory) ทั้งหมดอยู่ใน RAM ของ DO
3. **Fail-Fast Policy:** ตอบ HTTP 503 ทันทีถ้า Extension offline, HTTP 422 ถ้า model unverified, ไม่มี mock ใน production
4. **G1 Guardrail:** Google CSRF token (`SNlM0e`) อยู่ใน volatile browser MAIN-world RAM เท่านั้น ไม่ส่งข้าม WSS wire

## Consequences

### Positive
- **Strong consistency:** Single DO instance หมดปัญหา distributed state synchronization
- **Auto-scaling:** Cloudflare จัดการ scaling ของ Worker โดยอัตโนมัติ
- **No infrastructure management:** ไม่ต้องดูแล server, load balancer, หรือ database แยก
- **Low latency:** Edge execution ใกล้ผู้ใช้งาน

### Negative
- **Single instance constraint:** รองรับ Chrome Extension ได้แค่ 1 เครื่อง/1 บัญชีในเวลาเดียวกัน (connection ใหม่จะ replace เก่า)
- **In-memory only:** State หายเมื่อ DO restart (ไม่มี persistence สำหรับ conversation state)
- **Vendor lock-in:** ผูกกับ Cloudflare Durable Objects โดยเฉพาะ

## Alternatives Considered

| Alternative | Reason for Rejection |
|-------------|---------------------|
| Redis + Cloudflare Worker | เพิ่ม latency จาก round-trip ไป Redis และ infrastructure complexity สูงเกินไป |
| Kubernetes + WebSocket server | Overhead สูงเกินไปสำหรับ use case นี้ และต้องดูแล infrastructure เอง |
| Cloudflare KV | Eventual consistency ไม่เหมาะกับ real-time WebSocket state |

## Related
- `ARCHITECTURE.md` — Detailed architecture specification
- `docs/architecture.md` — Mermaid diagrams
- `PLANNING-HANDOFF.md` §1 — Original architecture overview
- `cloudflare-worker/src/index.js` — Implementation (lines 92-116 for state, 95, 291 for activeSocket)
