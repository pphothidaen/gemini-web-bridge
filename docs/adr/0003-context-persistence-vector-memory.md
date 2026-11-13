# ADR-003: Context Persistence & Vector Memory

## Metadata
- **Status:** Proposed (Roadmap Item #2)
- **Date:** 2026-11-13
- **Author:** Hermes Agent / Kim Leng Lim
- **Ticket:** KAN-236 (Roadmap)
- **Supersedes:** None (new capability)

## Context
ระบบปัจจุบันไม่มีความจำระยะยาว:
- `conversationState` (conversationId, responseId, choiceId) อยู่ใน RAM → หายเมื่อ DO restart
- ไม่มี semantic search ข้ามบทสนทนา
- ไม่มี knowledge base สำหรับ SDLC tools

ระบบต้องการเก็บประวัติบทสนทนาและ context ข้ามเซสชัน รองรับ semantic search (RAG) สำหรับ MCP tools และใช้เป็น knowledge base สำหรับ SDLC tools เช่น `sdlc_solution_architect`

## Decision
ใช้ **Cloudflare D1 (SQL)** เป็น persistent storage และ **Cloudflare Vectorize** สำหรับ semantic embeddings โดยมีสถาปัตยกรรมดังนี้:

1. **D1 Database (`BRIDGE_DB`):** เก็บ conversations และ messages แบบ relational (SQLite-compatible) พร้อม indices สำหรับค้นหาเร็ว
2. **Vectorize Index (`CONTEXT_INDEX`):** เก็บ embeddings ของข้อความสำหรับ semantic search (RAG)
3. **Context Store Module (`context-store.js`):** D1 CRUD operations (saveMessage, getHistory, pruneOlderThan)
4. **Vector Memory Module (`vector-memory.js`):** Embedding + search logic ใช้ Cloudflare Workers AI (`@cf/baai/bge-base-en-v1.5`) หรือ external embedding API
5. **Context Manager:** saveConversation(), searchContext(), getHistory(), pruneStaleContexts()
6. **MCP Tool Integration:** sdlc_solution_architect ดึง relevant context จาก vector memory มาเสริม prompt

## Consequences

### Positive
- **Long-term memory:** Conversation history คงอยู่ข้าม DO restart
- **Semantic search:** ค้นหาบทสนทนาที่เกี่ยวข้องผ่าน vector similarity แทน keyword matching
- **SDLC tool enrichment:** MCP tools สามารถใช้ context เก่าเสริมการตอบคำถามได้
- **Free tier compatible:** D1 Free plan = 5M rows/month reads, 100K writes/day (ต้อง prune เป็นประจำ)

### Negative
- **Row limits:** D1 Free plan มีข้อจำกัด 5M rows/เดือนสำหรับ reads, 100K writes/วัน ต้องมีกลไก prune ข้อมูลเก่า
- **Vectorize pricing:** ต้องคำนวณ cost ตามจำนวน vectors ที่เก็บ
- **Thai language support:** `bge-base-en-v1.5` อาจไม่รองรับภาษาไทยดี ต้องทดสอบ multilingual model
- **Privacy:** ข้อความที่เก็บใน D1/Vectorize จะอยู่บน Cloudflare ต้องพิจารณา data retention policy

## Alternatives Considered

| Alternative | Reason for Rejection |
|-------------|---------------------|
| Keep RAM-only state | ข้อมูลหายเมื่อ DO restart ไม่เหมาะสำหรับ production |
| External PostgreSQL + pgvector | เพิ่ม infrastructure complexity และค่าใช้จ่าย |
| Local SQLite file | ไม่สามารถแชร์ระหว่าง DO instances ได้ และไม่ persistent บน Cloudflare Edge |

## Related
- `PLANNING-HANDOFF.md` §3 — Context Persistence & Vector Memory design
- `cloudflare-worker/src/context-store.js` — New module to create
- `cloudflare-worker/src/vector-memory.js` — New module to create
- `wrangler.toml` — D1 and Vectorize binding configuration
