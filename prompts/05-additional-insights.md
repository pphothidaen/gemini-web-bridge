# 05 — Additional Insights

**One conversation.** Warnings and what the experts would flag.

The most useful request of the five, and the easiest to get wrong: a generic
"any other insights" invites exactly the general-knowledge filler that loses
grounding. Anchoring each item to a pillar keeps it in the notebook's material.

```
ตรวจสอบด้วยวิธีการของคุณเท่านั้น ไม่ใช้ความรู้ทั่วไป

{{NAME}} เกิด {{BIRTH_DATE}} เวลา {{BIRTH_TIME}} ที่ {{BIRTH_PLACE}}
(ลองจิ๋ม {{LONGITUDE}}°E)

ข้อมูลนี้คำนวณจากระบบ deterministic ของ backend แล้ว:
{{BIRTH_CONTEXT}}

จงชี้เฉพาะประเด็นที่สำคัญหรือเป็นคำเตือนสำหรับ {{NAME}} 5–7 ประเด็น
เรียงตามความสำคัญจากมากไปน้อย ถ้ามีน้อยกว่านั้นให้ใส่เท่าที่อ้างอิงได้

แต่ละประเด็น ระบุ:
- เรื่องที่ต้องระวัง
- เพราะอะไร — ต้องผูกกับเสาหรือธาตุในดวงเสมอ
- สิ่งที่ควรทำต่อ

ถ้าข้อมูลใน Notebook ไม่พอจะชี้ประเด็นด้านใด ให้บอกตรงๆ ว่าไม่มี
อย่าเติมสิ่งที่ไม่มีใน Notebook

ตอบโดยขึ้นต้นด้วยหัวข้อ `## ข้อควรระวัง (Additional Insights)` เพื่อให้ประกอบเป็นเอกสารเดียวได้
อ้างอิงแหล่งที่มาใน Notebook ทุกประเด็น
ตอบเป็นภาษาไทย
```

The "ถ้าไม่พอ ให้บอกตรงๆ" clause matters here more than in the other four.
A warnings section is exactly where a model reaches for generic advice, and
generic advice is exactly what produces an ungrounded answer.