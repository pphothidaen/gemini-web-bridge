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

## Yearly — the default

```
ตรวจสอบด้วยวิธีการของคุณเท่านั้น ไม่ใช้ความรู้ทั่วไป

{{NAME}} เกิด {{BIRTH_DATE}} เวลา {{BIRTH_TIME}} ที่ {{BIRTH_PLACE}}

ข้อมูลที่ระบบ deterministic คำนวณไว้:
{{BIRTH_CONTEXT}}

จงพยากรณ์ช่วงปี {{FROM_YEAR}}–{{TO_YEAR}} ปีละปี

แต่ละปี ระบุ:
- ธีมหลักของปีนั้นจากดวง
- เหตุการณ์สำคัญที่คาดว่าจะเกิด และช่วงเวลาในปี
- ความเสี่ยงที่ควรระวัง
- กลไกทางดวงที่สนับสนุนคำพยากรณ์นั้น

อ้างอิงแหล่งที่มาใน Notebook ทุกประเด็น
ตอบเป็นภาษาไทย
```

## Per-year, when the span is long

Replace the header line and drop the year range:

```
จงพยากรณ์ปี {{TARGET_YEAR}} เพียงปีเดียว แบบละเอียด โดยแจกแยงเป็น
ไตรมาสทั้ง 4 และระบุเหตุการณ์สำคัญหรือช่วงการเปลี่ยนแปลงดวงที่สำคัญ
ในแต่ละไตรมาส
```

## Per-quarter, when a single year needs detail

```
จงพยากรณ์ไตรมาส {{Q}} ปี {{TARGET_YEAR}} โดยละเอียด ระบุเหตุการณ์
สำคัญและช่วงเวลาภายในไตรมาสนี้ พร้อมกลไกทางดวงที่สนับสนุน
```

## Per-month — expect this to be refused

If monthly detail is genuinely needed, one conversation per month:

```
จงพยากรณ์เดือน {{MONTH}} ปี {{TARGET_YEAR}} โดยละเอียด
```

Each is one period, so each can ground or fail on its own. A refusal costs one
month instead of the whole five-year span.