# Gemini Web-Bridge

**Gemini Web-Bridge** เป็นระบบบริดจ์โปรโตคอลระดับท้องถิ่น (Local-First Protocol Bridge) ที่ทำหน้าที่เป็นตัวกลางเชื่อมระหว่างเซสชันเว็บเบราว์เซอร์ที่มีการยืนยันตัวตนแล้วของ Google Gemini (ผ่าน Google Account) เข้ากับเครื่องมือคอมมานด์ไลน์ (CLI), ไลบรารีมาตรฐานระดับอุตสาหกรรม, และระบบอัตโนมัติภายนอก ผ่าน REST API ที่เข้ากันได้กับมาตรฐาน OpenAI (`/v1/chat/completions` และ `/v1/models`)

---

## 1. วัตถุประสงค์ในการสร้าง (Project Purpose & Objectives)

1. **เชื่อมต่อ Web Session สู่ Terminal / Code Integration**:
   ช่วยให้นักพัฒนาและผู้ใช้งานสามารถเรียกใช้ความสามารถของโมเดล Google Gemini จากเว็บเบราว์เซอร์ผ่าน CLI (เช่น `aichat`, `mods`), Python OpenAI SDK, TypeScript, cURL, หรือ Framework ต่างๆ (เช่น LangChain, AutoGen) ได้โดยตรง โดยไม่ต้องสมัครหรือเสียค่าบริการ API เพิ่มเติม
2. **ความปลอดภัยแบบ Local-First (Zero Credential Leakage)**:
   ไม่มีการส่งรหัสผ่าน คุกกี้ หรือโทเคนการยืนยันตัวตนออกไปยังเซิร์ฟเวอร์ภายนอก ระบบทำงานบนเครื่องของผู้ใช้งานเท่านั้น (Localhost `127.0.0.1:8787`) การยืนยันตัวตนใช้ First-Party Cookies เดิมของเบราว์เซอร์ที่เปิดใช้งานอยู่
3. **OpenAI-Compatible Standard Interface**:
   จำลอง Endpoint และ Payload Schema ตามมาตรฐาน OpenAI ทั้งแบบ Non-streaming (JSON) และ Real-time Streaming (Server-Sent Events: SSE) ทำให้สามารถสลับใช้งานกับเครื่องมือที่รองรับ OpenAI ได้ทันทีโดยไม่ต้องแก้ไขโค้ดฝั่ง Client
4. **ความเสถียรและความต่อเนื่องของการสนทนา (Session State & Single-Flight Queue)**:
   รองรับการจำสถานะ Context บทสนทนาต่อเนื่อง (`conversationId`, `responseId`, `choiceId`) พร้อมระบบ Single-Flight Mutex Queue เพื่อเรียงลำดับคิวคำขอ ป้องกันสภาวะ Race Condition และปัญหาเซสชันตัดสลับ

---

## 2. โครงสร้างโปรเจกต์ (Project Directory Tree)

```text
gemini-web-bridge/
├── README.md                      # เอกสารคู่มือการใช้งาน วัตถุประสงค์ และรายละเอียดโปรเจกต์
├── ARCHITECTURE.md                # รายละเอียดสถาปัตยกรรมระบบ Data Flow และ Wire-Protocol
├── extension/                     # Chrome Extension (Manifest V3)
│   ├── manifest.json              # กำหนดสิทธิ์ Permission และ Context ขอบเขต
│   ├── content.js                 # Content Script ทำหน้าที่เป็น Bi-directional WebSocket Relay
│   └── injected.js                # สคริปต์ Main World ดึง Token และยิง Fetch API ภายใต้บริบทเว็บ
├── proxy/                         # Local Proxy Server (Node.js & TypeScript)
│   ├── package.json               # รายการ Dependencies และ Build Scripts
│   ├── package-lock.json          # Lockfile สำหรับ Node.js
│   ├── tsconfig.json              # การตั้งค่า TypeScript Compiler
│   ├── src/                       # ซอร์สโค้ดภาษา TypeScript
│   │   ├── types.ts               # โครงสร้าง Type Interfaces ทั้ง OpenAI และ Google RPC
│   │   ├── protocol-decoder.ts    # ตัวเข้ารหัสและถอดรหัสข้อความ Wire-Protocol (f.req / wrb.fr)
│   │   ├── queue.ts               # ระบบ Single-Flight Mutex Queue (FIFO)
│   │   ├── ws-bridge.ts           # WebSocket Bridge Server พร้อมกลไก Heartbeat
│   │   ├── server.ts              # Express Server ให้บริการ REST Endpoints (/v1/models, /v1/chat/completions)
│   │   └── index.ts               # Entrypoint หลัก เริ่มการทำงานบนพอร์ต 8787
│   └── dist/                      # ผลลัพธ์การคอมไพล์เป็น JavaScript สำหรับ Production
│       ├── types.js
│       ├── protocol-decoder.js
│       ├── queue.js
│       ├── ws-bridge.js
│       ├── server.js
│       └── index.js
└── tests/                         # ไฟล์สำหรับทดสอบระบบและการตั้งค่า Client
    ├── test_bridge.py             # สคริปต์ทดสอบสตรีมมิ่งผ่าน Python OpenAI SDK
    └── config-aichat.yaml         # ไฟล์ Config ตัวอย่างสำหรับ aichat CLI
```

---

## 3. สถาปัตยกรรมและการทำงานของระบบ (System Architecture & Workflow)

ระบบทำงานประสานกันผ่าน 4 เลเยอร์หลัก:

```text
+-------------------------------------------------------------------------+
|                              Client Layer                               |
|        (Python OpenAI SDK, aichat CLI, mods, cURL, LangChain)           |
+------------------------------------+------------------------------------+
                                     | HTTP POST /v1/chat/completions (SSE)
                                     v
+-------------------------------------------------------------------------+
|                           Bridge Proxy Server                           |
|                      (Node.js + Express + ws :8787)                     |
|  - RequestQueue: จัดการคิวคำขอแบบ Single-Flight FIFO                    |
|  - ProtocolDecoder: แปลง OpenAI Schema <-> Google RPC (f.req / wrb.fr)  |
|  - WebSocket Server: จัดการการเชื่อมต่อกับ Extension + Heartbeat Ping/Pong|
+------------------------------------+------------------------------------+
                                     | WebSocket Frame (ws://127.0.0.1:8787/bridge)
                                     v
+-------------------------------------------------------------------------+
|                        Chrome MV3 Extension                             |
|                           (content.js)                                  |
|  - เชื่อมต่อ WebSocket ไปยัง Local Proxy                                |
|  - ส่งต่อคำขอและผลลัพธ์ผ่าน window.postMessage                          |
+------------------------------------+------------------------------------+
                                     | window.postMessage
                                     v
+-------------------------------------------------------------------------+
|                      In-Page Execution Engine                           |
|                      (injected.js in Main World)                        |
|  - เข้าถึง window.WIZ_global_data สกัดโทเคน SNlM0e, FdrFJe, cfb2h       |
|  - ส่งคำขอ Native fetch() ไปยัง Google Web RPC                          |
|  - สตรีม Response Chunks กลับมายัง Content Script                       |
+------------------------------------+------------------------------------+
                                     | HTTPS POST (พร้อม First-Party Cookies)
                                     v
+-------------------------------------------------------------------------+
|                     Google Gemini Web Backend Service                   |
|       (https://gemini.google.com/_/BardChatUi/data/assistant...)        |
+-------------------------------------------------------------------------+
```

---

## 4. ความต้องการของระบบ (Prerequisites)

- **Node.js**: เวอร์ชัน 18.0.0 ขึ้นไป
- **Google Chrome / Chromium**: รองรับ Manifest V3
- **Python**: เวอร์ชัน 3.8 ขึ้นไป (สำหรับการรัน `test_bridge.py`) พร้อมติดตั้งแพ็กเกจ `openai` (`pip install openai`)
- **บัญชี Google**: ลงชื่อเข้าใช้งานบน https://gemini.google.com เรียบร้อยแล้ว

---

## 5. คู่มือเริ่มต้นใช้งาน (Quickstart Guide)

### ขั้นตอนที่ 1: รัน Local Bridge Proxy Server
1. เข้าไปที่โฟลเดอร์ `proxy/`:
   ```bash
   cd gemini-web-bridge/proxy
   ```
2. ติดตั้ง Dependencies และคอมไพล์โค้ด:
   ```bash
   npm install
   npm run build
   ```
3. เริ่มต้นรันเซิร์ฟเวอร์:
   ```bash
   npm start
   ```
   ระบบจะแสดงข้อความว่าเซิร์ฟเวอร์ทำงานอยู่ที่ `127.0.0.1:8787`:
   ```text
   =================================================
    Gemini Web-Bridge Proxy running on 127.0.0.1:8787
    Endpoint: http://127.0.0.1:8787/v1/chat/completions
    Ready for aichat, mods, and OpenAI SDK.
   =================================================
   ```

### ขั้นตอนที่ 2: ติดตั้ง Chrome Extension
1. เปิด Google Chrome แล้วไปที่ `chrome://extensions/`
2. เปิดสวิตช์ **Developer mode** ที่มุมขวาบนของหน้าจอ
3. คลิกปุ่ม **Load unpacked** (โหลดส่วนขยายที่ยังไม่ได้แพ็ก)
4. เลือกโฟลเดอร์ `gemini-web-bridge/extension`
5. ส่วนขยาย "Gemini Web-Bridge Extension" จะปรากฏในรายการ

### ขั้นตอนที่ 3: เปิดเซสชันเว็บ Gemini
1. เปิดแท็บเบราว์เซอร์ไปที่ https://gemini.google.com/
2. ตรวจสอบว่าลงชื่อเข้าใช้บัญชี Google เรียบร้อยแล้ว
3. สคริปต์ Extension จะตรวจจับหน้าเว็บ สกัดโทเคน `SNlM0e` และเชื่อมต่อกับ Proxy Server ที่รันอยู่โดยอัตโนมัติ (จะปรากฏข้อความยืนยันใน Console ของ Proxy: `Active session tokens synchronized`)

### ขั้นตอนที่ 4: ทดสอบการใช้งานผ่านไคลเอนต์

#### ตัวเลือก ก: ทดสอบด้วย Python OpenAI SDK
```bash
cd gemini-web-bridge
python3 tests/test_bridge.py
```
สคริปต์จะยิงคำขอไปยัง Proxy และสตรีมข้อความคำตอบออกมาทาง Terminal แบบเรียลไทม์

#### ตัวเลือก ข: ใช้งานผ่าน aichat CLI
1. คัดลอกการตั้งค่าใน `tests/config-aichat.yaml` ไปไว้ที่ `~/.config/aichat/config.yaml`
2. เรียกใช้งานได้ทันที:
   ```bash
   aichat "เขียนบทกวีสั้นเกี่ยวกับท้องฟ้ายามเย็น"
   ```

#### ตัวเลือก ค: ใช้งานผ่าน cURL
- **ตรวจสอบรายชื่อโมเดล**:
  ```bash
  curl http://127.0.0.1:8787/v1/models
  ```
- **ส่งคำขอแบบ Streaming**:
  ```bash
  curl -N http://127.0.0.1:8787/v1/chat/completions     -H "Content-Type: application/json"     -d '{
      "model": "gemini-web",
      "messages": [{"role": "user", "content": "สวัสดี Gemini Web-Bridge"}],
      "stream": true
    }'
  ```

---

## 6. ข้อมูลจำเพาะ API (API Specifications)

### 1. `GET /v1/models`
- **Output**: รายการโมเดลจำลองที่รองรับ
```json
{
  "object": "list",
  "data": [
    { "id": "gemini-web", "object": "model", "created": 1700000000, "owned_by": "google-web" },
    { "id": "gemini-web-thinking", "object": "model", "created": 1700000000, "owned_by": "google-web" }
  ]
}
```

### 2. `POST /v1/chat/completions`
- **Headers**: `Content-Type: application/json`
- **Request Body**:
  - `model` *(string)*: รหัสโมเดล เช่น `"gemini-web"`
  - `messages` *(array)*: รายการข้อความในรูปแบบ `[{"role": "user"|"system"|"assistant", "content": "..."}]`
  - `stream` *(boolean)*: `true` สำหรับ Server-Sent Events (SSE) หรือ `false` สำหรับคำตอบ JSON ตัวเต็ม
- **Responses**:
  - `200 OK`: สตรีมข้อมูล SSE หรือ JSON ตามสกีมา OpenAI
  - `503 Service Unavailable`: แจ้งเตือนเมื่อ Extension หรือเซสชันเบราว์เซอร์ยังไม่ได้เชื่อมต่อ

---

## 7. การรับมือความเสี่ยงและการแก้ไขปัญหา (Troubleshooting & Risk Matrix)

| อาการที่พบ (Symptoms) | สาเหตุที่เป็นไปได้ (Causes) | แนวทางแก้ไข (Mitigation) |
| :--- | :--- | :--- |
| **HTTP 503 Service Unavailable** | เบราว์เซอร์ยังไม่ได้เปิดหน้า Gemini หรือ Extension ยังไม่เชื่อมต่อ | 1. ตรวจสอบว่า Proxy รันอยู่<br>2. เปิดหน้า https://gemini.google.com/ ค้างไว้<br>3. Refresh หน้า Gemini หนึ่งครั้งเพื่อให้ Extension ทำการเชื่อมต่อใหม่ |
| **Missing SNlM0e token** | เซสชันบัญชี Google หมดอายุ หรือหน้าเว็บยังโหลดไม่เสร็จ | ทำการลงชื่อเข้าใช้ Google ใหม่ในเบราว์เซอร์ และรีเฟรชหน้าเว็บ |
| **Response หยุดนิ่ง หรือข้อความขาด** | Google ปรับเปลี่ยนโครงสร้าง RPC Payload | ตรวจสอบฟังก์ชัน `decodeChunk` ใน `proxy/src/protocol-decoder.ts` เพื่อปรับรูปแบบการแกะ Array ของ JSON ให้ตรงกับ Payload ล่าสุด |
| **คำขอหลายรายการประมวลผลพร้อมกัน** | มีการส่ง Request ซ้อนกันจากหลายโปรแกรม | ระบบมี `RequestQueue` ควบคุมแบบ Single-Flight Mutex FIFO อยู่แล้ว คำขอจะถูกต่อคิวและทำงานทีละรายการโดยอัตโนมัติ |
