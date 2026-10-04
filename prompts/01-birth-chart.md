# 01 — Birth Chart

**One conversation.** Narrow on purpose: the four pillars and what they mean,
nothing else. Broader requests in this area were measured to lose grounding.

```
ตรวจสอบด้วยวิธีการของคุณเท่านั้น ไม่ใช้ความรู้ทั่วไป

{{NAME}} เกิด {{BIRTH_DATE}} เวลา {{BIRTH_TIME}} ที่ {{BIRTH_PLACE}}
(ลองจิ๋ม {{LONGITUDE}}°E)

ข้อมูลนี้คำนวณจากระบบ deterministic ของ backend แล้ว:
{{BIRTH_CONTEXT}}

จงตอบตามลำดับนี้:
1. สี่เสาปีเกิด-เดือน-วัน-ชั่วโมง พร้อมอธิบายว่าแต่ละเสาบอกอะไร
2. อำนาจของ Day Master (ตัวแทนของตัวเอง) แข็งหรืออ่อน เพราะอะไร
3. สัดส่วนธาตุทั้งห้า และธาตุที่ควรใช้/ควรเลี่ยง
4. ถ้ามีระบบอื่นนอกเหนือจาก BaZi ที่อยู่ใน Notebook ให้ยกมาเพิ่ม — ถ้าไม่มี
   ก็บอกตรงๆ ว่าไม่มี อย่าเดา

อ้างอิงแหล่งที่มาใน Notebook ทุกประเด็น
ตอบเป็นภาษาไทย
```

## Why this is worded the way it is

**"ตรวจสอบด้วยวิธีการของคุณเท่านั้น ไม่ใช้ความรู้ทั่วไป"** is load-bearing.
Without it Gemini answers from its own training and the citation count drops to
zero — which is exactly what the broad template did.

**Never assert a pillar in the prompt.** Worked case, 2026-10-01:

| | asserted in prompt | engine (true solar time) |
| :--- | :--- | :--- |
| day pillar | 丁酉 | 丁酉 — agreed |
| hour pillar | 壬子 | **辛亥** — disagreed |

Ratchaburi is at 99.517°E against a 105°E standard meridian, so solar time is
21.9 minutes behind, plus −1.9 minutes of equation of time: 23:03 civil becomes
**22:39 true solar**, which is 亥 (21:00–23:00), not 子 (23:00–01:00). The
晚子時 question the prompt was built around never arises, and the 丁壬合化木
combination it asserted cannot occur because there is no 壬.

`{{BIRTH_CONTEXT}}` carries the engine's numbers. The prompt states them as
context to be explained, not as conclusions to be checked against.