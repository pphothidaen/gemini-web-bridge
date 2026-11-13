# ADR-002: Multi-Session Load Balancing

## Metadata
- **Status:** Proposed (Roadmap Item #1)
- **Date:** 2026-11-13
- **Author:** Hermes Agent / Kim Leng Lim
- **Ticket:** KAN-236 (Roadmap)
- **Supersedes:** ADR-001 (partial — extends single-instance to multi-instance)

## Context
ADR-001 กำหนดให้มี GeminiBridgeDO instance เดียว (`idFromName("global-bridge")`) ซึ่งทำให้ระบบรองรับ Chrome Extension ได้แค่ 1 เครื่อง/1 บัญชีเท่านั้น ปัญหาที่ตามมาคือ:
- ถ้า Extension เครื่องนั้น offline ระบบจะตอบ 503 ทั้งหมด
- ไม่สามารถกระจายโหลด AI client requests ไปยังหลาย browser session
- ไม่มี failover เมื่อ session หนึ่งมีปัญหา

## Decision
นำ **BridgeRouterDO** มาเป็น entrypoint ใหม่สำหรับ client requests โดยมีโครงสร้างดังนี้:

1. **BridgeRouterDO (New):** DO instance แยก (`idFromName("bridge-router")`) ทำหน้าที่เป็น registry ของ active sessions, health tracking per session, และ load balancing strategy (round-robin / least-loaded)
2. **Multiple GeminiBridgeDO Instances:** แต่ละ Chrome Extension session เชื่อมต่อเป็น GeminiBridgeDO แยกกัน (`idFromName("session-{sessionId}")`)
3. **Session Registry:** Router DO เก็บ `Map<sessionId, {lastSeen, queueDepth, modelCount, status}>` สำหรับติดตาม health ของแต่ละ session
4. **Least-Loaded Selection:** Router เลือก session ที่มี queueDepth ต่ำที่สุดและ status = "ready" สำหรับ client request แต่ละครั้ง
5. **Entrypoint Change:** WSS connection จาก Extension เชื่อมต่อตรงกับ session DO, ส่วน client HTTP request ผ่าน router ก่อน

## Consequences

### Positive
- **Multi-session support:** รองรับ Chrome Extension หลายเครื่อง/หลายบัญชีเชื่อมต่อพร้อมกัน
- **High availability:** ถ้า session หนึ่ง offline auto-reroute ไป session อื่นที่ยัง alive
- **Load balancing:** กระจายโหลดอย่างชาญฉลาดตาม queue depth ของแต่ละ session
- **Sticky sessions (optional):** Client สามารถ pin ไปยัง session เฉพาะผ่าน header ได้

### Negative
- **Billing cost:** แต่ละ DO instance มีค่าใช้จ่ายแยกบน Cloudflare ต้องคำนวณ cost เมื่อมีหลาย sessions
- **Conversation state pinning:** Multi-turn conversation ต้องไปที่ session เดิมเท่านั้น (state อยู่ใน DO RAM)
- **Google Gemini rate limit:** ต้องทดสอบว่า rate limit ทำงานอย่างไรเมื่อมีหลายบัญชีเรียกพร้อมกัน

## Alternatives Considered

| Alternative | Reason for Rejection |
|-------------|---------------------|
| Keep single instance | ไม่รองรับ multi-session และไม่มี failover |
| External load balancer (Nginx, Kong) | เพิ่ม infrastructure complexity และ latency; Cloudflare Free Tier มี rate limiting พอแล้ว |
| Redis session store | เพิ่ม component และ latency ไม่จำเป็นสำหรับ in-memory DO state |

## Related
- `PLANNING-HANDOFF.md` §2 — Multi-Session Load Balancing design
- `cloudflare-worker/src/index.js` — Entry point modification target
- `wrangler.toml` — DO binding configuration target
