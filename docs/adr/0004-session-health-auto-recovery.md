# ADR-004: Automated Session Health Recovery

## Metadata
- **Status:** Proposed (Roadmap Item #3)
- **Date:** 2026-11-13
- **Author:** Hermes Agent / Kim Leng Lim
- **Ticket:** KAN-236 (Roadmap)
- **Supersedes:** None (new capability)

## Context
ระบบปัจจุบันไม่มีกลไกตรวจจับและกู้คืน session อัตโนมัติ:
- ถ้า Chrome Extension disconnect → ระบบตอบ 503 ทันที แต่ไม่แจ้งเตือนผู้ใช้
- ถ้า Google session (cookie) หมดอายุ → Extension ยังเชื่อมต่ออยู่แต่ request จะ fail ด้วย auth error จาก Google
- ไม่มี heartbeat mechanism หรือ auto-reconnect สำหรับ Chrome Extension

## Decision
นำกลไก **Heartbeat & Auto-Reconnect** มาใช้ใน Chrome Extension และ Worker โดยมีรายละเอียดดังนี้:

1. **Heartbeat Mechanism:** Chrome Extension ส่ง heartbeat เป็นระยะผ่าน WSS เพื่อแจ้งว่า session ยัง alive
2. **Session Health Tracking:** GeminiBridgeDO ติดตาม `lastSeen` timestamp ของแต่ละ session ถ้าเกิน threshold (เช่น 30 วินาที) ถือว่า session ตาย
3. **Auto-Reconnect:** Extension พยายาม reconnect อัตโนมัติเมื่อหลุดการเชื่อมต่อ ด้วย exponential backoff
4. **GCP Hybrid Fallback:** เมื่อ WebSocket หลุดเกินเวลาที่กำหนด หรือ auth error จาก Google สลับไปใช้ `GEMINI_API_KEY` (GCP fallback) อัตโนมัติ
5. **Alerting:** ส่ง webhook notification (Discord/Slack) เมื่อ session หลุดหรือสลับไปใช้ fallback

## Consequences

### Positive
- **Higher availability:** ระบบกู้คืนตัวเองได้เมื่อ session หลุดหรือ cookie หมดอายุ
- **Graceful degradation:** สลับไปใช้ GCP fallback แทนที่จะตอบ 503 ทันที
- **Proactive alerting:** ผู้ดูแลระบบทราบปัญหาทันทีผ่าน webhook
- **Better UX:** ผู้ใช้ไม่ต้อง reconnect เองด้วยตนเอง

### Negative
- **Additional complexity:** ต้องจัดการ heartbeat interval, backoff strategy, และ fallback logic
- **GCP fallback cost:** การใช้ GCP Vertex AI อาจมีค่าใช้จ่ายหากใช้บ่อย
- **False positives:** อาจสลับไป fallback แม้ session จะแค่ชั่วคราว

## Alternatives Considered

| Alternative | Reason for Rejection |
|-------------|---------------------|
| Manual reconnect only | ผู้ใช้ต้องกระทำเอง ไม่เหมาะสำหรับ autonomous AI agents |
| External monitoring service | เพิ่มค่าใช้จ่ายและ complexity; ใช้ Grafana + Loki ที่มีอยู่แล้วเพียงพอ |
| Permanent GCP fallback | เสียค่าใช้จ่ายสูงเกินไป ควรใช้เฉพาะเมื่อจำเป็นเท่านั้น |

## Related
- `PLANNING-HANDOFF.md` §4 — Automated Session Health Recovery design
- `cloudflare-worker/src/index.js` — WSS connection and fallback logic
- `dist/extension/background.js` — Heartbeat and auto-reconnect implementation
- `~/.hermes/monitoring/` — Grafana + Loki stack for alerting
