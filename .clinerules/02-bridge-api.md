# horo_consult / Bridge API contract

- แหล่งความจริง: docs/api-spec.md — ห้ามออกแบบโดยไม่อ้าง spec
- เรียก horo_consult (MCP): ห้ามส่ง `scope` ถ้าต้องการ grounding (G-2)
  - การส่ง scope เป็นการ switch scope จริง ซึ่งปิดกลไก attach → คำตอบจะไม่ grounded
  - อย่าเรียก `set_bridge_scope("notebook:…")` เพื่อพยายาม ground — มันปิด attach และ navigate ออกจาก chat surface
- client timeout >= 180s; ยอมรับคำตอบเมื่อ notebookGrounding.verified === true เท่านั้น (G-1)
- คำนวณดวงชะตาเป็นหน้าที่ของเอนจิน deterministic — horo_consult รับ interpretation เท่านั้น (G-4)
  - ส่ง birth_context ที่คำนวณมาแล้วเข้ามา ห้ามให้โมเดลคำนวณซ้ำ
- discipline ที่ notebook ไม่ครอบคลุมต้องถูกปฏิเสธแบบ fail-closed (G-9) — ห้ามตอบจากความรู้ทั่วไป
- ตรวจ health ด้วย check_bridge_health ก่อน diagnose ปัญหา (ไม่เสีย Gemini round-trip)
  - JSON มี `notebook.last_grounding_status` (ดู cloudflare-worker/src/index.js)
- MCP transport: `POST /mcp` JSON-RPC 2.0 + `Authorization: Bearer <CLIENT_API_KEY>` — ทุก method
  - endpoint production อยู่หลัง Cloudflare WAF: client ที่ไม่มี browser-like User-Agent
    จะโดน Cloudflare Error 1010 (403) — ไม่ใช่ auth error
- **Canonical production host: `https://prod.gemini-web-bridge.workers.dev`**
  - ยืนยันจาก: wrangler.jsonc `name = "prod"`, CI/CD/keepalive-probe ทั้งหมด,
    และ live /health → version 4.7.18 + extension CONNECTED_AND_READY
  - **`https://gemini-web-bridge.pansakorn-pho.workers.dev` เป็น host เก่า (ก่อน migration
    KAN-157 / fa97a5d)** — ยังตอบ 200 และยังมี 9 tools แต่เป็น v4.4.3 ที่ค้างและ
    extension DISCONNECTED อยู่ มันถูกทิ้งไว้เป็น rollback target
  - ผลของการตั้ง MCP ผิด host: **ไม่มี error ให้เห็น** — tools ยัง list ได้ 9 ตัว
    แต่จะคุยกับ worker รุ่นเก่าที่ไม่มีโค้ดล่าสุด
  - ถ้าสงสัยว่า client ต่อ host ถูก: เทียบ `version` ใน /health กับ WORKER_VERSION
    ใน cloudflare-worker/package.json
- ถ้า extension หลุด: เปิด gemini.google.com tab ขึ้น foreground แล้ว reload แท็บ
  (ถ้าเพิ่ง reload extension ต้อง reload แท็บด้วย ไม่งั้น SESSION_READY ไม่ยิง)
- error ที่ต้องรู้: 401 key ผิด, 429 คิวเต็ม, 503 extension offline, -32000 grounding ไม่ผ่าน
