# Session Handoff — 2026-10-01

**งานวันนี้:** ทำให้ `horo_consult` (grounded BaZi reading) เดินครบวงจรใน
production และวัดว่า payload ของ Gemini หน้าตาเป็นอย่างไร เพื่อประเมินว่า
จะเลิกขับ DOM แล้วยิง API ตรงได้ไหม

**Read-only ก่อนเสมอ:** `cd cloudflare-worker && npm test` ·
`python3 scripts/build-extension.py --verify` · `curl …/health`

---

## 1. สถานะตอนจบ

| | |
| :--- | :--- |
| HEAD | `1a872d6` (main) |
| **ยังไม่ push** | **2 commits** — `920da49`(docs), `1a872d6`(fixture) |
| untracked | `prompts/` 7 ไฟล์ — **ยังไม่ commit ตั้งใจ** |
| production | **4.7.24**, `CONNECTED_AND_READY`, `consecutive_errors: 2` |
| tests | 619 / 608 pass / **0 fail** / 5 skipped |

**push ก่อนเสมอ** — `cd.yml` deploy เมื่อ `cloudflare-worker/**` เปลี่ยน
และต้องอนุมัติที่ environment `production` (required reviewer)

---

## 2. สิ่งที่ทำและ deploy แล้ว — 6 tickets

| Ticket | Version | สิ่งที่แก้ |
| :--- | :--- | :--- |
| KAN-234 | 4.7.22 | `/v2` router + `api_version_contract.test.mjs` (13) + policy §14 |
| KAN-233a | 4.7.22 | health counter: typed path ไม่เคย reset |
| KAN-231 | 4.7.23 | capture typing surface, DOM contract 6 → 13 signals |
| KAN-235 | 4.7.23 | `isGenerating()` เห็น thinking phase แล้ว |
| KAN-236a | 4.7.24 | collection deadline เป็น idle-based |
| KAN-232 | — | Cline config chmod 600 + `timeout: 240` |

### ผลที่พิสูจน์ได้จริงใน production

- `notebookGrounding.verified: true`, `citationCount: 14`,
  `attachedInPlace: true` — **grounding path เดินครบวงจร**
- notebook **ยืนยันผลคำนวณของ `bazi_engine.py` ตรงทุกตัวอักษร**
  (乙丑/甲申/丁酉/**辛亥**) → True Solar Time ถูก, promptที่บังคับ`壬子` ผิด
- `/v1` และ `/v2` คืน body เดียวกันใน production

---

## 3. 🟢 บันทึกไว้แล้วในโค้ด — อย่าทำซ้ำ

**DOM signal contract** (`tests/helpers/dom-signal.mjs`) — signal ที่ไม่มี
capture ทำให้ build fail ป้องกัน KAN-192/197/198 ที่ผิด3ครั้งเพราะ
"proxy ถูกอ่านเป็นตัวจริง"

**`/v2` router** — prefix ถูกตัดครั้งเดียว ทั้งสองเวอร์ชันอ่าน handler เดียวกัน
→ "v1 = v2" เป็นโครงสร้าง ไม่ใช่ข้อตกลง

**KAN-235** — `generatingSignal` เช็ค `thinking-dots-animation` หลัง block
ของ response (ต้องไม่ mask `response_aria_busy`)

---

## 4. 🔴 ยังค้าง — เรียงตามลำดับที่ควรทำ

### 4.1 KAN-242 — typed path ล้มเมื่อ conversation สะสม turn

```
collect_answer_timeout, responses on screen=2  → ไม่มี StreamGenerate ออกเลย
```

| conversation | turns | ผล |
| :--- | :--- | :--- |
| ใหม่ | 0 | 12 วินาที สำเร็จ |
| `1055552f96923f8c` | 1 | 14 citations ✅ |
| `72d00678d54a08dd` | 2+ | **ล้ม 2 ครั้งติด** |

**ตัวแยกที่ใช้ได้:** ถ้า StreamGenerate ถูกยิง = prompt ออกแล้ว ปัญหาอยู่ที่ collect
ถ้าไม่ยิง = prompt ไม่ออก — วัดแล้ว**ไม่ยิง**

> **ยืนยันแล้วว่า conversation ใหม่แก้ปัญหานี้ได้** — คุณเปิด
> `/app/9a5f98acf78ec0f8` ถามใหม่ ได้ 2 chips ปกติ

### 4.2 KAN-231 — capture ที่หายไป (ไม่ใช่ bug โค้ด)

`prompt-typing.js` ยังไม่มี capture ครบ 4 สถานะ และ `sendButtonFallback`
match 0 ทุกสถานะ = ไม่ใช่ safety net

### 4.3 KAN-236 — capture 2/3 + diff tool

**ต้องการอีก 1 capture** (chip-absent) เพื่อยืนยัน field [19]

### 4.4 ค้างจาก session ก่อนๆ

| Ticket | เรื่อง |
| :--- | :--- |
| KAN-232 | **rotate GitHub PAT** — PAT หลุดใน transcriptตอน inspect config |
| — | `prompts/` 7 ไฟล์ ยังไม่มีหลักฐานว่าใช้ได้ |

---

## 5. KAN-236: ผลการวัด payload

**Endpoint:**
```
POST https://gemini.google.com/_/BardChatUi/data/
      assistant.lamda.BardFrontendService/StreamGenerate
```

**worker สร้าง 10 field · browser ส่ง 19 field**

| index | worker (`index.js:150-159`) | จริง | สำคัญ |
| :--- | :--- | :--- | :--- |
| 2 | `[convId, respId, choiceId, …]` | **`null`** | 🔴 **ขัดเชิงชนิด** |
| 3 | ไม่มี | 2187 bytes opaque | 🔑 context block |
| 4 | ไม่มี | 32 hex | conversationId ✅ยืนยันจากresponse |
| 19 | ไม่มี | 46 bytes opaque | ❓ สมมติฐานว่าเป็น notebook ref |

### ข้อสรุปที่มั่นใจแล้ว

**การยิงตรงจาก worker ไม่ใช่ "เติม field ที่ขาด"** — index 2 ขัดกันเชิง
ชนิดข้อมูล ต้องสร้าง payload ใหม่ทั้งก้อน

### context block

- 2187 bytes ใน conversationสั้น · ~4096 ใน conversationยาว
- **ความยาวแปรผันตาม conversation** → ไม่ใช่ nonceคงที่
- สร้างซ้ำได้ไหม → **ยังไม่รู้** นี่คือคำถามหลักของงานนี้

### กับดักที่เจอ: classifier มองไม่เห็น

```js
NOTEBOOK_REF: "notebook://"    ← มี ://
payload จริง: "notebooks/"      ← ไม่มี
```

→ KAN-195 เลยเห็นแค่**ความยาวต่าง** ระหว่าง grounded/ungrounded ซึ่งคือความ
กำกวมที่ test นั้นถูกเขียนมาแก้ **แต่แก้ผิด prefix**

### ข้อค้นพบเชิงโครงสร้าง

**หน้า notebook ไม่ host conversation** — ถามที่นั่นจะ redirectไป `/app`
สร้าง conversationใหม่ → notebook ref เป็นคุณสมบัติของ **chip** ใน `/app`
ไม่ใช่ของหน้า → **แผน 4 เคส → 3 เคส**

---

## 6. วิธี capture — ใช้ Kapture อย่างเดียว

| | PAYLOAD_PROBE | **Kapture network** |
| :--- | :--- | :--- |
| รอดเมื่อ navigate | ❌ | ✅ |
| เปิดเอง | ทุกหน้า | ไม่ต้อง |
| ได้ข้อมูล | shape | **f.req ดิบ** |

**probe ถูกออกแบบให้ console-only ตาม G1.2.1 ซึ่งถูกต้องสำหรับ build ที่ ship**
แต่แปลว่าทุก navigation ต้องเปิดใหม่

```
kapture__network_monitor {enabled:false, force:true}   # ล้าง buffer
kapture__network_monitor {enabled:true}              # buffer = 0
… ถาม …
kapture__network_requests {limit:20, since:<cursor>}
kapture__network_body {requestId}
```

> ⚠️ **buffer หมุนที่ 2000** — ล้างก่อนทุกครั้ง และ**อ่านเป็นช่วงๆ ไม่ใช่ครั้งเดียวท้ายสุด**
> (ผมพลาดเพราะอ่านครั้งเดียวตอนจบ แล้ว request เกิดไปแล้ว)

**`kapture__evaluate` ใช้ไม่ได้บนแท็บนี้** — คืน `{}` แม้แต่ `1+1`
(relocate ก็ไม่ช่วย) จึงส่ง `window.postMessage` เองไม่ได้

---

## 7. กฎที่ต้องไม่ผิดซ้ำ

1. **วัดก่อนตีความ** — session นี้ตีความผิด3ครั้งจากข้อมูลไม่ครบ
   (ครั้งหนึ่งเขียนว่า notebook ว่างเปล่า ทั้งที่มีเอกสารจริง)
2. **รายงานผิดเอง** — เคยสรุปว่า bridge พังจาก error 3 ครั้งติด แล้วมันกลับผ่าน
   ที่แก้คือ**โพสต์ comment ยกเลิก** ไม่ใช่แก้เงียบๆ
3. **ห้ามอ้างเกินหลักฐาน** — เคยเขียน `prompts/README.md` ว่า "splitting does not
   weaken the analysis" ทั้งที่ทดสอบแล้ว**ขัดกัน** → ไฟล์นั้นยังไม่ commit
4. **อย่าเดาเมื่อมีเครื่องมือวัด** — ตอนนี้มี `checkDomSignals()`,
   mutation check, `payload probe` ให้ใช้

---

## 8. คำสั่งที่ใช้บ่อย

```bash
cd cloudflare-worker && npm test                    # ~2 นาที
python3 scripts/build-extension.py --verify         # ต้อง current ก่อนเชื่อผลจริง
curl -s https://prod.gemini-web-bridge.workers.dev/health | python3 -m json.tool

gh run list --workflow=cd.yml --limit 1
gh run view <id>
# approve:
ENV=$(gh api "repos/pphothidaen/gemini-web-bridge/actions/runs/$RUN/pending_deployments" \
      --jq '.[0].environment.id')
gh api -X POST "repos/.../actions/runs/$RUN/pending_deployments" \
   --input - <<< "{\"environment_ids\":[$ENV],\"state\":\"approved\"}"

twg jira workitem get KAN-<n>
twg jira workitem comment create --issue-id KAN-<n> --body "..." --body-format markdown
```

**Host:** `https://prod.gemini-web-bridge.workers.dev` เท่านั้น
`gemini-web-bridge.pansakorn-pho.workers.dev` = retired (4.7.21, DISCONNECTED)
→ **fail เงียบ ไม่มี error** มี test บังคับ: `production-host.test.mjs`

---

## 9. จุดที่ผมทำผิดใน session นี้ — อย่าทำซ้ำ

| ผิดพลาด | ผล |
| :--- | :--- |
| ใช้ `write_file --mode rewrite` เขียนทับ `docs/api-spec.md` ทั้งไฟล์ | 297 → 59 บรรทัด กู้จาก git ได้เพราะ tracked |
| edit กินบรรทัด `id:` ทำให้ syntax พัง | ตรวจ `node --check` ทุกครั้ง |
| print config file ทั้งไฟล์ | **PAT หลุดใน transcript** → ต้อง rotate |
| สรุปว่า bridge พังจาก error3ครั้ง | ผิด — ตอนจริงผ่านรอบที่4 |
| เขียน README อ้างเกินหลักฐาน | ยังไม่ commit |
| อ่าน network buffer ครั้งเดียวตอนจบ | พลาด request ที่ต้องการ |

---

## 10. ข้อเสนอลำดับถัดไป

1. **Rotate GitHub PAT** — 5 นาที, ปิดความเสี่ยงค้าง
2. **push 2 commits** — ปลอดภัย (docs+fixture ไม่แตะ runtime)
3. **KAN-236** — capture chip-absetอีก 1 ครั้ง → diff tool → assessment
   (ข้อสรุปอาจเป็น **"ยิงตรงไม่ได้"** ซึ่งเป็นผลที่ถูกต้อง)
4. **KAN-242** — typed path ล้มเมื่อ conversation ยาว ต้องแก้ก่อนใช้งานจริงเป็นประจำ
5. **`prompts/`** — ทิ้งหรือรื้อ หลังมีหลักฐานว่าใช้ได้

> **ทั้งหมดนี้ยังไม่มีการ deploy** — production คือ 4.7.24 ที่ deploy ไปแล้ว
> ส่วนที่เหลือเป็นงานวัด ไม่ใช่งานแก้ production