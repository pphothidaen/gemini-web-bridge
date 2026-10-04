# 04 — Forecast

**One conversation per request.** Granularity is a parameter, not a default.

## Why granularity is a parameter

Monthly detail for five years is 60 periods. Measured 2026-10-01, a request
carrying five sections at monthly granularity grounded with **zero** citations
and was refused. The coarse end has not been measured, but the arithmetic is
clear: every period is another thing that must be answerable from notebook
material, and only so much of it is there.

| `{{GRANULARITY}}` | periods | expected |
| :--- | --- | --- |
| `yearly` | 5 | start here |
| `quarterly` | 20 | try if yearly grounds cleanly |
| `monthly` | 60 | expect refusal; split by year |

Note the two meanings of "quarter": `quarterly` in this ladder means every
quarter of every year (20 periods). The *one quarter of one year* variant
below is a different thing — the fallback when a single quarter fails or one
quarter needs more depth than its yearly row can carry.

## Yearly — the default

```
ตรวจสอบด้วยวิธีการของคุณเท่านั้น ไม่ใช้ความรู้ทั่วไป

{{NAME}} เกิด {{BIRTH_DATE}} เวลา {{BIRTH_TIME}} ที่ {{BIRTH_PLACE}}
(ลองจิ๋ม {{LONGITUDE}}°E)

ข้อมูลนี้คำนวณจากระบบ deterministic ของ backend แล้ว:
{{BIRTH_CONTEXT}}

จงพยากรณ์ช่วงปี {{FROM_YEAR}}–{{TO_YEAR}} ปีละปี

แต่ละปี ระบุ:
- ธีมหลักของปีนั้นจากดวง
- เหตุการณ์สำคัญที่คาดว่าจะเกิด และช่วงเวลาในปี
- ความเสี่ยงที่ควรระวัง
- กลไกทางดวงที่สนับสนุนคำพยากรณ์นั้น

ถ้าข้อมูลใน Notebook ไม่พอจะพยากรณ์ปีด้านใด ให้บอกตรงๆ ว่าไม่มี
อย่าเติมสิ่งที่ไม่มีใน Notebook

ตอบโดยขึ้นต้นด้วยหัวข้อ `## พยากรณ์อนาคต (Future Forecast)` เพื่อให้ประกอบเป็นเอกสารเดียวได้
อ้างอิงแหล่งที่มาใน Notebook ทุกประเด็น
ตอบเป็นภาษาไทย
```

## Per-year, when the span is long

Replace the forecast request line with this; keep the field list, honesty
clause, heading, and closing lines:

```
จงพยากรณ์ปี {{TARGET_YEAR}} เพียงปีเดียว แบบละเอียด โดยแจกแยงเป็น
ไตรมาสทั้ง 4 และระบุเหตุการณ์สำคัญหรือช่วงการเปลี่ยนแปลงดวงที่สำคัญ
ในแต่ละไตรมาส พร้อมกลไกทางดวงที่สนับสนุนในแต่ละไตรมาส
```

## One quarter of one year

Same block as yearly, with the forecast request line replaced by:

```
จงพยากรณ์ไตรมาส {{Q}} ปี {{TARGET_YEAR}} โดยละเอียด ระบุเหตุการณ์
สำคัญและช่วงเวลาภายในไตรมาสนี้ ความเสี่ยงที่ควรระวัง พร้อมกลไกทางดวง
ที่สนับสนุน
```

## Per-month — expect this to be refused

If monthly detail is genuinely needed, one conversation per month. Same block
as yearly, with the forecast request line replaced by:

```
จงพยากรณ์เดือน {{MONTH}} ปี {{TARGET_YEAR}} โดยละเอียด ระบุเหตุการณ์
สำคัญและช่วงเวลาภายในเดือน ความเสี่ยงที่ควรระวัง และกลไกทางดวงที่สนับสนุน
```

The per-quarter and per-month variants previously carried no field list and —
for the month — no mechanism requirement. That put the weakest grounding
contract on the granularity closest to the refusal cliff, which is backwards:
the finer the granularity, the more each period needs its mechanism stated to
stay in notebook material.

Each is one period, so each can ground or fail on its own. A refusal costs one
month instead of the whole five-year span.

## Reassembling a split span

If the range had to be run year by year, concatenate the per-year answers in
chronological order under the single `## พยากรณ์อนาคต (Future Forecast)`
heading before document assembly — the split is an execution tactic, not a
document structure.