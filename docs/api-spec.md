# API Specification — `horo_consult` (Notebook-Grounded Consultation)

> **สถานะ:** Design v1.0 (grounded กับโค้ดจริง) · **วันที่:** 2026-09-29
> **ผู้ให้บริการ:** Gemini Web Bridge Cloud Hub (`cloudflare-worker/src/index.js`)
> **Consumers:** ZCode/Agent MCP clients, HoroConsultant backend (`project/core/llm_gateway.py` adapter — วางแผนไว้), สคริปต์ทดสอบ
> **Designated notebook:** `https://gemini.google.com/notebook/b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0` (display name `Horo`, canonical scope id `notebook:b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0`)

---

## 1. บทบาทและขอบเขต

`horo_consult` เป็น MCP tool ที่ตอบคำถามโหราศาสตร์จีน (BaZi), เลขศาสตร์ (numerology) และโหราศาสตร์ไทย โดย **grounded ใน NotebookLM notebook ที่ผูกไว้** — ทุกคำตอบต้องมี citation จาก notebook จึงจะถูกส่งกลับ คำตอบที่ไม่มี citation จะถูกปฏิเสธ (fail-closed) ไม่ใช่ส่งกลับแบบเงียบ ๆ

ขอบเขตชัดเจนสองด้าน:

- **ใช้ได้:** งาน interpretation/ที่ปรึกษา — อ่านดวงชะตาจากบริบทที่ผู้เรียกคำนวณมาแล้ว
- **ห้ามใช้:** งานคำนวณ deterministic (แปดตัวอักษร, แผนภูมิ, องค์ประกอบ 5) — เอนจินฝั่ง backend เป็นผู้คำนวณแล้วส่ง `birth_context` เข้ามาเท่านั้น ("Birth chart context (deterministic engine output, do not recalculate)")

## 2. Notebook Grounding Model (หัวใจของ spec นี้)

อ้างอิง KAN-177 / KAN-182 (`index.js:3276-3293`, `index.js:3519-3530`):

1. **Attach in-place ไม่ใช่ navigation** — เมื่อเรียก `horo_consult` **โดยไม่ระบุ `scope`** ระบบจะแนบ notebook ชื่อ `Horo` เข้ากับบทสนทนา `/app/<id>` ที่เปิดอยู่ (ผ่าน attach dialog) โดยไม่เปลี่ยน URL ของแท็บ เพราะหน้า `/notebook/<id>` ไม่ใช่ chat surface — ถ้า navigate ไป query จะถูกยิงเข้า conversation ใหม่และ scope หลุดก่อนคำตอบมา
2. **Attachment ถูกใช้ต่อข้อความ (consumed per message)** — attach สำเร็จรอบหนึ่งไม่การันตีข้อความถัดไปจะ grounded การ reuse จึงห้ามทำโดยพฤตินัย และระบบ verify ภายหลังทุกครั้ง
3. **Verify หลังได้คำตอบ** — attach สำเร็จเป็นแค่ "UI success" ระบบจะเช็ค citation ในคำตอบจริง (`verifyNotebookGrounding`, `index.js:1969`, `index.js:3763-3806`) ถ้าไม่มี citation จาก notebook → คืน error ไม่คืนคำตอบ
4. **Replay path ห้ามใช้กับ notebook grounding** — payload แบบ replay แบก `notebook://…/sources/…` ไม่ได้ (พิสูจน์บน wire แล้วใน KAN-182) `horo_consult` ทุกเส้นทาง MCP วิ่งบน typed path เท่านั้น (`index.js:3692-3717`)
5. **Idempotent attach** — เรียกซ้ำต้นทุนต่ำ attach ซ้ำไม่ทำอะไรบนฝั่ง extension

### กติกา `scope` (ตารางที่ consumer ต้องจำ)

| ค่า `scope` ที่ส่ง | พฤติกรรม | Notebook grounding |
| :--- | :--- | :--- |
| **ไม่ส่ง (แนะนำ)** | แนบ notebook `Horo` เข้า conversation ปัจจุบัน in-place, คืน scope เดิมหลังเสร็จ, `bridgeScope.attachedInPlace = true` | ✅ บังคับ verify, fail-closed |
| `"app"`, `"app:<convId>"`, `"notebook:<id>"`, URL | **Switch scope จริง** ตามค่าที่ส่ง | ❌ ไม่มี attach และไม่มี verify — คำตอบจะไม่ grounded ใน notebook |

> [!CAUTION]
> **อย่าเรียก `set_bridge_scope("notebook:b55f1ee0-…")` เพื่อพยายาม ground `horo_consult`** — การส่ง `scope` ชัดเจนจะ *ปิด* กลไก attach ของ tool และ scope `notebook:` ทำให้เกิด navigation ไปหน้าที่ไม่ใช่ chat surface วิธีเดียวที่ได้คำตอบ grounded คือ **ไม่ส่ง `scope`** แล้วปล่อยให้ default attach ทำงาน

## 3. Transport — MCP over HTTPS

- **Endpoint:** `POST {BASE}/mcp` โดย `BASE` = `https://prod.gemini-web-bridge.workers.dev`
- **Protocol:** JSON-RPC 2.0 / MCP spec 2024-11-05 (`initialize` คืน `serverInfo: gemini-web-bridge-cloud-hub`, echo `protocolVersion`)
- **Auth (บังคับ):** `Authorization: Bearer <CLIENT_API_KEY>` — ทุก method (`index.js:2642-2647`) ยกเว้นเฉพาะ `GET /artifacts/{key}`
- **Session:** `Mcp-Session-Id` header หรือ query `sessionId` (ส่งกลับมาให้ใน response) — stateless POST ต่อ request ใช้งานได้โดยไม่ต้องเปิด SSE stream
- **Discovery:** `tools/list` คืน inputSchema เต็มของทุก tool; `ping` เช็ค health ย่อ
- **หมายเหตุ:** มี legacy SSE transport ผ่าน `GET /mcp` สำหรับ client ที่ต้องการ push — REST-style POST ตอบ JSON-RPC ตรง ๆ ใช้งานได้ทั่วไป

### JSON-RPC error codes ที่ใช้

| code | ความหมาย |
| :--- | :--- |
| `-32700` | Parse error (JSON พัง) |
| `-32600` | Invalid Request (batch ว่าง ฯลฯ) |
| `-32601` | Method not found |
| `-32602` | Invalid params — ขาด `query`, `scope` ที่ไม่รู้จัก, scope switch ล้มเหลว |
| `-32000` | Execution error — extension ตัดการเชื่อมต่อ, attach notebook ล้ม, **grounding ไม่ผ่าน verify**, คำตอบว่าง, GCP fallback ล้ม, tool execution failed |

HTTP-level: `401` key ไม่ถูก, `429` คิวเต็ม, `503` extension offline (ฝั่ง REST `/v1/*`)

## 4. Tool `horo_consult` — Input Schema

อ้างอิง `index.js:3042-3064`:

```json
{
  "name": "horo_consult",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string" },
      "birth_context": {
        "type": "object",
        "properties": {
          "birth_datetime":   { "type": "string" },
          "longitude":        { "type": "number" },
          "utc_offset_hours": { "type": "number" },
          "day_master":       { "type": "string" },
          "five_elements":    { "type": "string" },
          "favorable_elements": { "type": "string" }
        }
      },
      "response_format": { "type": "string", "enum": ["text", "pdf"], "default": "text" },
      "scope": { "type": "string" }
    },
    "required": ["query"]
  }
}
```

| Field | บังคับ | คำอธิบาย |
| :--- | :--- | :--- |
| `query` | ✅ | คำถามโหราศาสตร์ ตอบเป็นภาษาเดียวกับที่ถาม (worker ใส่ language directive ให้เอง) ต้องเป็น string ที่ไม่ว่าง |
| `birth_context` | — | บริบทดวงชะตา **จากเอนจิน deterministic ของ backend** — field ไหนว่าง/undefined จะถูกตัดออกจาก prompt ไม่ serialize เป็น `null` |
| `response_format` | — | `text` (default) หรือ `pdf` |
| `scope` | — | **ห้ามส่งถ้าต้องการ notebook grounding** — ดูตาราง §2 |

## 5. Prompt Composition (สิ่งที่ worker ส่งจริงไป Gemini)

อ้างอิง `prompt-templates.js:136-152` — worker ประกอบ prompt เอง ผู้เรียกควบคุมไม่ได้ (และไม่จำเป็นต้องควบคุม):

1. Persona: "Act as ซินแส AI ผู้เชี่ยวชาญโหราศาสตร์จีน (BaZi), numerology และดาราศาสตร์ไทย ตอบโดยอ้างอิงความรู้ใน Notebook ที่ผูกไว้เป็นหลัก"
2. บรรทัด birth context: `นี่คือข้อมูลดวงชะตาของฉัน: <k>: <v>, ...` (หรือ "ฉันยังไม่ได้ให้ข้อมูลวันเกิดมาเลย" ถ้าไม่ส่ง)
3. คำถาม: `คำถามของฉันคือ: <query>`
4. Output directive: โครงสร้างชัดเจน, **ตอบเป็นภาษาเดียวกับคำถาม**, ระบุขีดจำกัดของการอ่าน

## 6. Response Contract (success)

อ้างอิง `index.js:3726-3834`, `3865-3897`:

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "<คำตอบเต็ม>" }],
    "structuredContent": { "pdf_url": "https://…/artifacts/<32-hex>" },
    "bridgeScope": {
      "used": "notebook:b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0",
      "active": "app (default)",
      "restored": true,
      "attachedInPlace": true
    },
    "notebookGrounding": {
      "requested": "Horo",
      "attached": true,
      "attachedNames": ["Horo"],
      "step": null,
      "reason": null,
      "verified": true,
      "verifiedReason": null,
      "citationCount": 3,
      "citeMarkers": 3,
      "citedSources": ["…"]
    }
  }
}
```

- `bridgeScope.used` = **intent scope** (notebook ที่ attach) — `active` คือ scope จริงของแท็บ (`attachedInPlace` ทำให้สองค่านี้ต่างกันโดยดีไซน์)
- `notebookGrounding.verified = true` **เป็นหลักฐานเดียว** ที่บอกว่าคำตอบมาจาก notebook (attach สำเร็จอย่างเดียวไม่พอ)
- `structuredContent` ปรากฏเฉพาะเมื่อ `response_format: "pdf"` และ `ARTIFACT_KV` ถูก bind — ถ้าไม่มี binding หรือ render พัง จะเป็นบรรทัดเตือนต่อท้าย `text` **แทนที่จะ error** ผู้เรียกต้องเช็คการมีอยู่ของ `pdf_url` เอง
- คำตอบว่าง/blank จะไม่ถูกส่งกลับเด็ดขาด (fail-closed เป็น error หรือ GCP fallback)

### PDF artifact

- `GET /artifacts/<key>` — public, key 32-hex **ตัว key คือ credential** ห้าม log/ส่งต่อใน channel ที่ไม่ตั้งใจ
- TTL **1 ชั่วโมง** (`expirationTtl: 3600`) — **ห้ามเก็บ URL ลง DB เป็น reference ถาวร** ถ้าต้องเก็บให้ดาวน์โหลด content ทันทีแล้วเก็บไฟล์เอง หมดอายุแล้วจะได้ `404 {"error":"artifact_not_found_or_expired"}`

## 7. Error & Fail-Closed Matrix

| สถานการณ์ | ผลลัพธ์ที่ consumer เห็น | การกระทำที่แนะนำ |
| :--- | :--- | :--- |
| ขาด `query` | `-32602` ก่อนใช้ทรัพยากรใด ๆ | แก้ payload |
| Attach notebook ล้ม (แท็บถูก minimize, dialog ไม่ขึ้น) | `-32000` `notebook_attach_failed` พร้อม `step`/`reason` — **ไม่มีคำตอบส่งกลับ** | นำแท็บ Gemini ขึ้น foreground แล้ว retry |
| คำตอบไม่มี citation จาก notebook | `-32000` grounding unverified — ไม่มีคำตอบ | **เริ่ม conversation ใหม่** (attachment ถูกใช้ต่อข้อความ) แล้ว retry 1 ครั้ง |
| คำตอบว่างหลัง decode | `-32000` empty response — grounding-required call **ไม่เดิน GCP fallback** | Retry |
| Extension offline | `-32000` (MCP) / `503` (REST); grounding-required call **ไม่เดิน GCP fallback**; tool อื่น fallback ได้ | ดูกติกา fallback ด้านล่าง |
| คิวเต็ม (>10 waiters) | HTTP `429` | Backoff แล้ว retry |
| `scope` พิมพ์ผิด/ไม่รู้จัก | `-32602` พร้อมข้อความ usage | แก้ค่า scope |

> [!IMPORTANT]
> **GCP fallback (fail-closed ตั้งแต่ KAN-204):** ก่อนหน้านี้เมื่อ extension ตัดการเชื่อมต่อและ worker มี `GEMINI_API_KEY` call ที่ต้องการ grounding อาจกลับมาเป็น **สำเร็จ** แต่ไม่ grounded (ไม่มี `notebookGrounding`, ข้อความขึ้นต้น `[Provider: GCP Gemini Fallback]`) — ตอนนี้ worker **ปิดช่องนี้แล้วทั้ง 3 เส้นทาง** (extension offline, คำตอบว่าง, transient error): call ที่ต้องการ grounding จะได้ `-32000` เสมอ ไม่มีการตอบจาก GCP ผู้เรียกยังควรตรวจ `notebookGrounding.verified === true` ต่อไปเป็น defense-in-depth (ป้องกัน worker เวอร์ชันเก่าและ call แบบ explicit-scope ที่ไม่มี grounding claim ให้ตัดสิน)

## 8. Timing, Concurrency & Latency Pattern

| ขั้น | Timeout ฝั่ง worker |
| :--- | :--- |
| Notebook attach (`runNotebookAttach`) | 45 s |
| พิมพ์ prompt ผ่าน UI (`typePromptThroughUi`) | 60 s |
| เก็บคำตอบ typed (`collectTypedAnswer`) | 120 s |
| Verify grounding (`verifyNotebookGrounding`) | 35 s |

- **คิว:** FIFO 1 concurrent, รอได้สูงกันสุด 10 requests, คิว deadline 60 s, เต็ม → `429` — mutex ระดับ DO จัดการให้แล้ว **consumer ห้าม implement queue ซ้ำ**
- **Client timeout ที่แนะนำ: ≥ 180 s** (worst-case chain ≈ 45+60+120+35 ≈ 260 s; ทั่วไป 30–120 s) — timeout ระดับ 6–8 s แบบ provider API ปกติใช้ไม่ได้เด็ดขาด
- **Latency pattern:** ห้าม block HTTP request ผู้ใช้ — ฝั่ง backend ควรเรียกแบบ async task แล้วเปิด endpoint poll/job ให้ client (`202 Accepted` + job id) worker ไม่มี job API ให้ จึงเป็น pattern ฝั่ง caller ล้วน

## 9. Integration Contract — HoroConsultant LLM Gateway Adapter

ผู้เรียกตัวจริงคือ `project/core/llm_gateway.py` ของ HoroConsultant (tiers ปัจจุบัน: 1 cloudflare-workers-ai, 2 gemini, 3 codex, 4 claude, 5 ollama, 6 deterministic — circuit breaker 3 fails → open 60 s)

### 9.1 Provider ใหม่

| องค์ประกอบ | ค่า |
| :--- | :--- |
| key | `"aipass_bridge"` |
| tier | **3** (แทรกหลัง gemini) — `ProviderState.tier` เป็น `int` จึงต้อง **renumber** codex→4, claude→5, ollama→6, deterministic→7 (tier "2.5" ใช้ไม่ได้กับ typing ปัจจุบัน) |
| `is_configured` | `bool(AIPASS_BRIDGE_BASE_URL)` **และ** `bool(CLIENT_API_KEY)` **และ** consent flag `HORO_BRIDGE_CONSENT=true` |
| `_call_aipass_bridge()` | httpx async → `POST {AIPASS_BRIDGE_BASE_URL}/mcp`, `tools/call`, timeout **180–240 s** |
| circuit breaker | กลไกเดิมใช้ได้ทันที — adapter ต้อง raise ProviderError ทุกกรณีในตาราง §7 |

### 9.2 Request mapping

```python
args = {
  "query": f"{focused_query}\n\n[ข้อจำกัด] ตอบเฉพาะศาสตร์ {discipline}; ห้ามคำนวณดวงชะตาเอง ใช้เฉพาะ birth_context ที่ให้",
  "birth_context": {   # คำนวณจากเอนจิน deterministic ก่อนเสมอ
    "birth_datetime": "...", "longitude": 100.5018, "utc_offset_hours": 7,
    "day_master": "甲木", "five_elements": "木2 火1 土3 金1 水1", "favorable_elements": "火土",
  },
  "response_format": "text",   # ไม่ส่ง scope — บังคับ default notebook attach
}
```

- **ห้ามส่ง `scope`** ใน adapter ของ path นี้ (§2) — scope hygiene จริง ๆ คือ "ไม่ส่ง" ไม่ใช่ "ส่งทุกครั้ง"
- **Discipline gate (fail-closed):** notebook ครอบคลุมแค่ BaZi / เลขศาสตร์ / โหราศาสตร์ไทย — discipline อื่น (ziwei, qimen, iching ฯลฯ) router ต้องปฏิเสธและ route กลับ node prompts/debate เดิม ห้าม fallback เงียบ ๆ
- **Domain firewall รวมลง `query`:** `horo_consult` ไม่มีช่อง system prompt — ข้อจำกัดศาสตร์ + ห้ามคำนวณเอง ต้อง prepend ใน `query` (ดึงจาก `question_focus_router.build_focused_prompt()`)

### 9.3 Response mapping → gateway schema

```python
{
  "text": result["content"][0]["text"],
  "provider": "aipass_bridge",
  "model": "gemini-web-notebook",
  "latency_ms": elapsed_ms,
  "fallback_triggered": False,
  "provenance": {
    "grounding": result["bridgeScope"]["used"],        # notebook:b55f1ee0-…
    "grounding_verified": result["notebookGrounding"]["verified"],
    "citations": result["notebookGrounding"]["citationCount"],
    "cited_sources": result["notebookGrounding"]["citedSources"],
    "input_sha256": sha256(canonical_json(args)),
  },
}
```

**Hard guard ก่อนยอมรับคำตอบ** (เข้าเงื่อนไข HITL/audit ของโปรเจค):

1. `notebookGrounding.verified === true` — ไม่ใช่ → raise ProviderError (รวมกรณี GCP fallback: ไม่มี field `notebookGrounding` หรือ text ขึ้นต้น `[Provider: GCP Gemini Fallback]` — worker ปิดช่องนี้แล้วตั้งแต่ KAN-204 จึงเหลือเป็น defense-in-depth)
2. `bridgeScope.used == "notebook:b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0"`
3. `text` ไม่ว่าง
4. (config flag) ส่งผ่าน `project/validator.py` เพื่อคุมคุณภาพเทียบเส้นทางอื่น

### 9.4 Privacy

`birth_datetime` + ข้อมูลดวงชะตาถูกส่งเข้า Google web session ภายนอก — บังคับเป็น **opt-in per deployment**: env `HORO_BRIDGE_CONSENT` + consent ฝั่งผู้ใช้ก่อนเรียก และ anonymize ชื่อ/ข้อมูลส่วนบุคคลอื่นที่ไม่จำเป็นออกจาก `query` ก่อนส่ง (ทำใน adapter ไม่ใช่ปล่อยให้ caller จัดการเอง)

## 10. Health & Observability

- `check_bridge_health` → block `notebook`: `target_name` (`Horo`), `target_scope`, `last_attach_status`, `last_attach_reason`, `attach_failures`, **`last_grounding_status`** (`grounded`/`ungrounded`/`unknown`) — grounding คือตัวชี้วัดจริง attach สำเร็จอย่างเดียวไม่พอ
- `ping` → scope ปัจจุบัน, สถานะ extension, latency ล่าสุด
- Adapter ควรใช้ `check_bridge_health` เป็น preflight ตอน `is_configured`/health-check ของ gateway (ไม่เสีย Gemini round-trip)

## 11. Conformance Examples

### เรียกแบบ text (grounded — ไม่ส่ง scope)

```bash
curl -s "$BASE/mcp" \
  -H "Authorization: Bearer $CLIENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0", "id": 1, "method": "tools/call",
    "params": { "name": "horo_consult", "arguments": {
      "query": "อาชีพที่เหมาะกับดวงนี้คืออะไร",
      "birth_context": {
        "birth_datetime": "1990-05-14T08:30:00",
        "longitude": 100.5018, "utc_offset_hours": 7,
        "day_master": "甲木", "five_elements": "木2 火1 土3 金1 水1",
        "favorable_elements": "火土"
      }
    }}
  }'
```

### เรียกแบบ PDF

เหมือนข้างบนแต่เพิ่ม `"response_format": "pdf"` — อ่าน `result.structuredContent.pdf_url`, ดาวน์โหลดภายใน 1 ชั่วโมง

### Fail-closed grounding (ตัวอย่าง error)

```json
{ "jsonrpc": "2.0", "id": 1,
  "error": { "code": -32000,
    "message": "horo_consult attached the \"Horo\" notebook, but the answer came back with no citations from it (reason=…). …" } }
```

## 12. Invariants (ผ่าน/ไม่ผ่าน conformance)

| # | Invariant |
| :--- | :--- |
| G-1 | คำตอบ `horo_consult` ที่ยอมรับได้ต้องมี `notebookGrounding.verified === true` |
| G-2 | ห้ามเรียก `horo_consult` พร้อม `scope` เมื่อต้องการ grounding — การส่ง scope ปิดกลไก attach |
| G-3 | ห้าม route grounding-required request เข้า replay path (typed path เท่านั้น) |
| G-4 | คำนวณดวงชะตาเป็นของเอนจิน deterministic — `horo_consult` รับ interpretation เท่านั้น |
| G-5 | คำตอบว่าง/blank ห้ามส่งถึง consumer เป็น success |
| G-6 | PDF URL มีอายุ 1 ชม. — ห้าม persist เป็น reference ถาวร |
| G-7 | Consumer timeout ≥ 180 s และต้องรับ `429`/`503`/`-32000` ด้วย backoff ไม่ retry ถี่ |
| G-8 | การส่ง birth data ออกนอกระบบต้องผ่าน consent gate (opt-in per deployment) |
| G-9 | Discipline ที่ notebook ไม่ครอบคลุมต้องถูกปฏิเสธแบบ fail-closed ไม่ใช่ตอบจากความรู้ทั่วไป |

## 13. แผนงาน (atomic tickets)

1. **bridge adapter provider** — `aipass_bridge` tier 3 + renumber + `_call_aipass_bridge()` + contract tests ฝั่ง mapping (HoroConsultant repo)
2. **discipline gate + router wiring** — fail-closed ที่ `/api/v2/interpret/focused` และเส้นทาง interpret อื่น
3. **health/status integration** — preflight `check_bridge_health` + expose grounding provenance ใน response meta
4. **202/job endpoint** — poll pattern สำหรับ interpret ที่ block นาน
5. ก่อน release: รัน governance gate ของ HoroConsultant repo (`sync_ai_agent_ecosystem.py --check`)
## 14. Versioning และ backward compatibility ของ REST surface

กฎนี้บังคับด้วย `cloudflare-worker/tests/api_version_contract.test.mjs` — ถ้า
โค้ดละเมิด ให้ถือว่า test ต้องแดง ไม่ใช่ "ปรับ test ให้ผ่าน"

### 14.1 เส้นทางที่มีเวอร์ชัน

| Path | สถานะ |
| :--- | :--- |
| `/v1/models` | **Frozen** — ห้ามเปลี่ยน response shape |
| `/v1/chat/completions` | **Frozen** — ห้ามเปลี่ยน response shape |
| `/v2/models` | เปิด ปัจจุบันคืน byte-identical กับ v1 |
| `/v2/chat/completions` | เปิด ปัจจุบันคืน byte-identical กับ v1 |
| `/models` | alias ไม่มีเวอร์ชัน → ทำงานเหมือน v1 |

### 14.2 เส้นทางที่ไม่มีเวอร์ชัน (ตั้งใจไม่ version)

`/` · `/health` · `/mcp` · `/bridge` · `/bridge/auth-check` · `/bridge/reset`
· `/artifacts/{key}`

เหตุผลที่ `/v1/mcp` **ไม่** ให้ใช้: MCP มี `Mcp-Session-Id` เป็น namespace ของตัวเอง
แล้ว การเพิ่ม alias แบบ versioned จะสร้าง session namespace ที่ไม่มีใคร
negotiate ร่วมกัน — เป็นการสร้างปัญหาใหม่โดยไม่ได้แก้ปัญหาเดิม

เหตุผลที่ auth gate คูณกับ `url.pathname` ไม่ใช่ path ที่ตัด prefix แล้ว:
`/health` อยู่ใน public allowlist ถ้า auth ตัดสินใจจาก path ที่ตัด prefix
`/v1/health` จะกลายเป็น public โดยอัตโนมัติ และ leak health report ทั้งก้อน
(model ids, scope, connection state) ให้ใครก็ได้ — จึงมี test จับไว้โดยเฉพาะ

### 14.3 กฎ

1. **v1 frozen** — ถ้าการเปลี่ยนแปลงทำให้ response shape ของ v1 เปลี่ยน
   นั่นคือ breaking change และต้องไป `/v2` เท่านั้น ห้ามแก้ใน v1
2. **เพิ่ม field ได้** — additive change ไม่ทำให้ client เดิมพัง จึงอนุญาต
   โดยไม่ต้องขึ้น v2 แต่ต้องเพิ่มใน exact key set ของ test ด้วย
3. **v1 และ v2 ต้องไม่ diverge จนกว่าจะมีเหตุผล** — ปัจจุบันทั้งคู่ต้องคืน
   body เดียวกันทุก byte ถ้าจะให้ต่างกันต้องเขียนเหตุผลลง CHANGELOG
4. **version ที่ไม่รู้จักต้องตอบ 404 พร้อมชื่อ** — `code: "unsupported_api_version"`
   ไม่ใช่ generic `not_found` ที่อ่านเหมือนพิมพ์ผิด ทำให้ caller ไปหา
   credential problem ที่ไม่มี
5. **เพิ่ม version ใหม่ = แก้ 3 ที่** — `SUPPORTED_API_VERSIONS` ใน
   `src/index.js`, `api_versions` ใน `/health`, และ test

### 14.4 ทำไมต้องมี test guard

ก่อนหน้านี้ไม่มีอะไรกันไม่ให้ breaking change ออกไป — version prefix ถูก
hardcode ไว้ใน 4 จุดเปรียบเทียบ `url.pathname === "/v1/..."` ทำให้ไม่มีที่
เดียวที่ต้องตัดสินใจอย่างตั้งใจ และไม่มี assertion ใดที่ยืนยันว่า shape ยังเป็น
shape เดิม

`api_version_contract.test.mjs` ปิดช่องนี้ และผ่าน mutation check ทั้ง 4 ตัว
(ดู comment ท้ายไฟล์) — mutation ที่ไม่ทำให้ผลเปลี่ยน แปลว่า assertion
ตกลวง ผลที่วัดได้เมื่อรันจริง:

| Mutation | ทำให้ test แดง |
| :--- | :--- |
| A — ลบ `v2` ออกจาก `SUPPORTED_API_VERSIONS` | 6 |
| B — `/models` ไม่คืน `catalog_revision` | 1 (เฉพาะ exact key set) |
| C — auth gate ใช้ `apiPath` แทน `url.pathname` | 1 |
| D — รวม `unsupported_api_version` เข้า `not_found` | 2 |

Mutation B แดงแค่ 1 เป็นหลักฐานว่าสองชั้นของ test ตรวจคนละอย่างจริง —
ชั้น "v1 เท่า v2" กันการ diverge ส่วนชั้น "exact key set" กันการสูญเสีย field
ไม่มีชั้นใดกันซ้ำอีก

### 14.5 Deprecation

`/health` มี `api_versions.deprecated` (ปัจจุบัน `{}`) สำหรับประกาศว่า
version ใดกำลังจะถูกถอด พร้อมเหตุผล กฎคือ **ยังไม่มีกำหนด sunset ใด ๆ
จนกว่าจะมี ticket ที่ระบุวัน** — การประกาศ deprecation โดยไม่มีวันถอด
ทำให้ client หยุดอัปเดตโดยไม่มีแรงกดดันที่จะบังคับให้รีบ