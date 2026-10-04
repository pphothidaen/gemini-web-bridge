# 03 — Turning Points

**One conversation.** Ages at which life turns, and the mechanism behind each.

Asking for *why* each turning point happens is what keeps this answerable: it
forces the reading back onto the chart rather than onto generic life-cycle
narratives.

```
ตรวจสอบด้วยวิธีการของคุณเท่านั้น ไม่ใช้ความรู้ทั่วไป

{{NAME}} เกิด {{BIRTH_DATE}} เวลา {{BIRTH_TIME}} ที่ {{BIRTH_PLACE}}
(ลองจิ๋ม {{LONGITUDE}}°E)

ข้อมูลนี้คำนวณจากระบบ deterministic ของ backend แล้ว:
{{BIRTH_CONTEXT}}

จงระบุจุดเปลี่ยนสำคัญของชีวิต {{NAME}} เรียงตามอายุ 5–8 จุด
จากอายุน้อยไปมาก ถ้า Notebook มีเนื้อหารองรับน้อยกว่านั้น ให้ใส่เท่าที่มี
อย่าเติมจุดที่ไม่มีกลไกในดวงรองรับ

สำหรับแต่ละจุด ระบุ:
- อายุที่จะเกิดขึ้น (ปี พ.ศ. — พ.ศ. คือ ค.ศ. + 543 จงคำนวณจากปีเกิดที่ให้)
- เหตุการณ์รูปธรรมว่าจะเป็นอย่างไร
- กลไกทางดวงที่ทำให้เกิดขึ้น — เช่น การเปลี่ยนแปลงปีนักษา หรือการรวมตัว
  ของธาตุ อธิบายกลไก ไม่ใช่แค่บอกว่าจะเกิดอะไรขึ้น

ถ้าข้อมูลใน Notebook ไม่พอจะชี้จุดเปลี่ยนด้านใด ให้บอกตรงๆ ว่าไม่มี
อย่าเติมสิ่งที่ไม่มีใน Notebook

ตอบโดยขึ้นต้นด้วยหัวข้อ `## จุดเปลี่ยน (Turning Points)` เพื่อให้ประกอบเป็นเอกสารเดียวได้
อ้างอิงแหล่งที่มาใน Notebook ทุกประเด็น
ตอบเป็นภาษาไทย
```

## A note on precision

Asking for a specific age is a strong ask and the honest failure mode here is
a plausible-sounding age with no chart behind it. The mechanism clause above
is what makes that visible — an age with no stated mechanism is the thing to
reject, not to refine. The count bound (5–8) exists for the same reason:
an open-ended list invites filler entries once the real ones run out.