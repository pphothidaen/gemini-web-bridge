# Gemini Web-Bridge: Architecture & Data Flow Specification

เอกสารนี้ระบุรายละเอียดทางสถาปัตยกรรมซอฟต์แวร์ กลไกความปลอดภัย และขั้นตอนการไหลของข้อมูล (Data Flow) สำหรับระบบ **Gemini Web-Bridge**

---

## 1. การแบ่งแยกขอบเขตและบริบทการทำงาน (Context Boundaries)

ระบบถูกออกแบบโดยยึดหลัก **Defense in Depth** และ **Zero External Credential Exposure**:
1. **Host Boundary (127.0.0.1)**: การสื่อสารระหว่าง Client CLI และ Proxy Server ทำงานผ่าน Loopback Interface ภายในเครื่องเท่านั้น ไม่มีการเปิดพอร์ตออกสู่ภายนอก
2. **WebSocket Bridge**: สื่อสารเฉพาะระหว่าง Extension และ Local Proxy ผ่าน `ws://127.0.0.1:8787/bridge`
3. **Isolated World vs Main World**:
   - `content.js` ทำงานใน Isolated World มีสิทธิ์เข้าถึง Chrome Extension APIs แต่เข้าถึงตัวแปร JavaScript ของเว็บเพจโดยตรงไม่ได้
   - `injected.js` ถูกแทรกเข้าไปใน Main World (Page Context) จึงสามารถเข้าถึงตัวแปร `window.WIZ_global_data` และเรียกใช้ Native `fetch()` ภายใต้ Origin และ First-Party Cookies ของ Gemini ได้อย่างสมบูรณ์

---

## 2. ลำดับขั้นตอนการทำงาน (Sequence Diagram)

```text
Client (CLI/SDK)      Proxy Server (Node.js)    Content Script       Injected Script (Main World)     Google Gemini Backend
       |                        |                      |                             |                          |
       |                        |                      |                             |                          |
       |                        |                      |----- Load injected.js ----->|                          |
       |                        |                      |                             |                          |
       |                        |                      |<-- postMessage(TOKENS) -----| (Extract SNlM0e)         |
       |                        |<-- WS(SESSION_READY)-|                             |                          |
       |                        |                      |                             |                          |
       |-- POST /chat/compl. -->|                      |                             |                          |
       |                        | [Enqueue in Mutex]   |                             |                          |
       |                        |-- WS(EXEC_REQUEST) ->|                             |                          |
       |                        |                      |-- postMessage(EXEC_STREAM)->|                          |
       |                        |                      |                             |-- POST /StreamGenerate ->|
       |                        |                      |                             |<-- HTTP 200 (Stream) ----|
       |                        |                      |                             |                          |
       |                        |<-- WS(STREAM_CHUNK) -|<-- postMessage(CHUNK) ------| (Read Stream Chunk)      |
       |                        | [Decode RPC / wrb.fr]|                             |                          |
       |<-- SSE chunk (delta) --|                      |                             |                          |
       |        ...             |        ...           |        ...                  |        ...               |
       |                        |<-- WS(STREAM_DONE) --|<-- postMessage(DONE) -------| (Stream Completed)       |
       |<-- SSE "data: [DONE]" -|                      |                             |                          |
       |                        | [Release Mutex]      |                             |                          |
```

---

## 3. รายละเอียดโปรโตคอล (Wire-Protocol Decoding)

Google Gemini Web UI ใช้วิธีส่งข้อมูลแบบ Batched RPC ผ่าน Envelope ดังนี้:
- **Prefix Guard**: `)]}'` ถูกวางไว้ที่ส่วนหัวเพื่อป้องกัน JSON Hijacking
- **RPC Format**: ส่งข้อมูลแบบ Chunks หลายบรรทัด โดยมีตัวเลขระบุความยาว หรือ JSON Array ที่มี Header `wrb.fr`
- **Payload Extraction**:
  - `innerData[4][0][1][0]`: ข้อความผลลัพธ์ (Text Delta)
  - `innerData[1][0]`: Conversation ID สำหรับสืบทอด Context การสนทนา
  - `innerData[1][1]`: Response ID
  - `innerData[4][0][0]`: Choice ID
