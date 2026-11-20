# ADR-0006: Gemini Native Routes and Google Search Grounding Support

## Metadata
- **Status:** Accepted
- **Date:** 2026-11-20
- **Author:** Hermes Agent / Kim Leng Lim
- **Ticket:** KAN-351 (Parent Epic: KAN-350)
- **Supersedes:** None (enhancement to edge routing and capability catalog)

## Context
Gemini Web Bridge ทำหน้าที่เป็น Edge-to-Browser Gateway ระหว่าง AI Clients (เช่น Hermes Agent, Cursor, Cline, Google Gen AI SDK) และ Google Gemini Session
เดิมที Gateway ให้บริการเฉพาะ OpenAI-compatible endpoints ภายใต้ `/v1/chat/completions` และ `/v1/models` ซึ่งมีข้อจำกัด:
1. **Schema Incompatibility:** AI Clients ที่ส่งคำขอในรูปแบบ Gemini Native (เช่น `contents` พร้อม `parts`, `systemInstruction`) หรือระบุ Native Tools เช่น `tools: [{"google_search": {}}]` จะถูก reject โดย OpenAI schema validator ด้วยข้อผิดพลาด 400 "messages must be a non-empty array" หรือ "tools must contain named function definitions"
2. **Search Grounding Capability Discovery:** Clients ไม่มีช่องทางในการค้นหา (discover) โมเดล Gemini ที่มี Search Grounding capability (`capabilities: { grounding: true }`) ผ่าน endpoint `/models`
3. **Feature Flag Control:** มีความจำเป็นต้องมี Feature Flag (`GEMINI_NATIVE_ENABLED`) เพื่อควบคุมการเปิด/ปิดความสามารถนี้ในระดับ Edge Environment โดยไม่กระทบต่อ core routing เดิม

## Decision
สร้างกลุ่ม Gemini-Native Endpoints ภายใต้ `/v1/gemini/*` บน Cloudflare Worker และ Durable Objects (`GeminiBridgeDO`):

1. **Endpoint `GET /v1/gemini/models`:**
   - ส่งกลับรายการโมเดล Gemini Native พร้อม Grounding Capability Metadata:
     ```json
     {
       "object": "list",
       "data": [
         {
           "id": "gemini-3.5-flash-lite",
           "object": "model",
           "owned_by": "google",
           "capabilities": { "grounding": true }
         },
         {
           "id": "gemini-3.1-pro-preview",
           "object": "model",
           "owned_by": "google",
           "capabilities": { "grounding": true }
         }
       ]
     }
     ```
   - ป้องกันด้วย Bearer Authentication ผ่าน `CLIENT_API_KEY` ตามมาตรฐานความปลอดภัยของเกตเวย์

2. **Endpoint `POST /v1/gemini/chat/completions`:**
   - รองรับ Request Body ทั้งรูปแบบ Gemini-Native (`contents`, `parts`, `systemInstruction`) ทั้งแบบ array และ single Content object ตลอดจน OpenAI-style (`messages`)
   - รองรับ Google Search Grounding ผ่าน `tools: [{"google_search": {}}]`, `tools: [{"googleSearch": {}}]`, หรือ `tools: [{"google_search_retrieval": {}}]` โดยไม่แปลงเป็น OpenAI function call schema ที่ทำให้เกิด error
   - รองรับ Gemini-native Function Calling ผ่าน `tools: [{"functionDeclarations": [...]}]` และ Mixed Toolsets (Google Search + Function Tools) ในรอบการสนทนาเดียวกัน
   - แมป Native Model ID (`gemini-3.5-flash-lite`, `gemini-3.1-pro-preview`) ไปยัง verified browser model ที่ active อยู่ในเซสชันอย่างราบรื่น
   - ส่งออกผลลัพธ์แบบ Dual Compatibility:
     - OpenAI format: `choices` พร้อม `message` และ `finish_reason`
     - Gemini Native format: `candidates` พร้อม `content.parts` (รองรับทั้ง text และ structured `functionCall` เมื่อโมเดลเรียก tool), `finishReason: "TOOL_CALLS" | "STOP"`, และ `groundingMetadata`
     - รองรับทั้ง Non-Streaming JSON และ SSE Streaming (`data: {"choices": [...], "candidates": [...]}`)

3. **Feature Flag Guard (`GEMINI_NATIVE_ENABLED`):**
   - ควบคุมการทำงานของเส้นทาง `/v1/gemini/*` ทั้งหมด
   - ค่าเริ่มต้นคือ `true` (เปิดใช้งาน)
   - หากกำหนดค่าเป็น `false`, `"false"`, `"0"`, `"off"`, หรือ `"no"` ใน environment bindings เส้นทาง `/v1/gemini/*` จะคืนค่า HTTP 404 พร้อม error payload `gemini_native_disabled` ทันทีตั้งแต่ Pre-Auth Routing Gate (ก่อนถึง Bearer Auth Check) และไม่ค้างใน request queue

4. **Authentication & Rate Limiting Parity:**
   - ใช้กลไก Bearer Token Validation (`CLIENT_API_KEY`) สอดคล้องกับเส้นทาง `/v1/*` เดิมทุกประการเมื่อ feature flag เปิดอยู่
   - เข้าร่วม Browser Concurrency Queue (`requestBusy`, `pendingRequests`) เพื่อปกป้อง Chrome Extension tab จาก concurrency overload

## Consequences

### Positive
- **First-Class Gemini Tooling:** รองรับการใช้งาน Search Grounding ร่วมกับ Gemini web session ได้โดยตรง
- **Multi-Client Versatility:** รองรับทั้ง clients ที่ใช้ OpenAI format และ clients ที่ใช้ Gemini Native format
- **Fail-Fast Safety:** ตรวจสอบความถูกต้องของ payload ก่อนเข้าสู่ extension queue ป้องกันการใช้ทรัพยากร isolate โดยเปล่าประโยชน์
- **Zero-Dependency Footprint:** รักษาข้อกำหนดเรื่อง bundle size และ low CPU overhead บน Cloudflare Workers Free Tier

### Negative
- **Payload Dual-Mapping Maintenance:** หาก Google เพิ่ม schema รูปแบบใหม่ใน Gemini API ในอนาคต อาจต้องปรับปรุง normalizer ให้ครอบคลุม

## Alternatives Considered
| ทางเลือก | เหตุผลที่ไม่เลือก |
|---|---|
| บังคับให้ AI Client แปลง schema มาเป็น OpenAI format เอง | Client สูญเสีย Search Grounding native capabilities และสร้างภาระการ implement ให้กับ caller |
| สร้าง Worker แยกต่างหากสำหรับ Gemini Native | สิ้นเปลือง resource บน Cloudflare Free Tier และสูญเสีย WebSocket connection pool ร่วมกับ Durable Object เดียวกัน |

## Related Files
- `cloudflare-worker/src/index.js` — Routing, request normalization, and Gemini native endpoint handling
- `cloudflare-worker/tests/gemini-native-routes.test.mjs` — Comprehensive unit and integration test suite
- `docs/architecture.md` — Mermaid architecture diagrams and ADR index table
