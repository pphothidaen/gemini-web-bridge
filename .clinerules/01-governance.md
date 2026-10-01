# Project Governance (gemini-web-bridge)

- อ่าน GUARDRAILS.md (G1-G5) และ docs/api-spec.md (invariants G-1..G-9) ก่อนแตะโค้ดทุกครั้ง
- ทุก commit: `KAN-<id>: <description>` — ยืนยัน ticket มีจริงด้วย
  `twg jira workitem get KAN-<id>` ก่อน cite เสมอ
  (ห้ามเดาเลข ticket — ดู docs/COMMIT_TICKET_MAPPING.md)
- hooks ใน repo นี้บังคับอยู่แล้ว (`core.hooksPath=.githooks`):
  - `commit-msg` ตรวจรูปแบบ `KAN-<id>:` ในบรรทัดแรก
  - `pre-push` ถาม Jira ว่า ticket ที่ cite มีอยู่จริงไหม (fail-closed เมื่อ Jira ตอบว่าไม่มี)
- ห้าม print/log BRIDGE_AUTH_TOKEN, CLIENT_API_KEY, SNlM0e (G1 Zero-Token-Leak)
  - อย่า commit secret ลง `.clinerules/` — ไฟล์นี้อยู่ใน git
  - ดึง secret สดด้วย `doppler secrets get <NAME> --project gemini-web-bridge --config prd`
- ห้าม TODO/FIXME/HACK/XXX/BLOCKER ใน cloudflare-worker/src/ และ extension-cloudflare/ (G4.1.1)
  - งานค้างให้บันทึกใน PLANNING-HANDOFF.md เท่านั้น
- ก่อน push: `cd cloudflare-worker && npm test` ต้องผ่าน 0 fail
- fail-closed เสมอ: gate ที่อ่าน Jira/external oracle ไม่ได้ ต้องไม่ตีความว่า "ผ่าน"

## สัญญาณจาก infra = ต้องเปิด ticket เสมอ

ถ้าเจอ**คำเตือนจากระบบข้างนอก** — deprecation, forced version, migration
notice, upcoming removal date, action/runtime warning — ให้เปิด ticket ทันที
และ**ตั้ง priority ตามผลกระทบจริง** ห้ามปล่อยให้ผ่านไปเพราะ "ยังไม่พัง"

กติกา:
1. **Backlog / To Do** เสมอ ยกเว้นมีเหตุผลที่เขียนไว้ว่าทำไม
2. **Priority ต้องอ้างอิงนิยามของ Jira เอง** ไม่ใช่ความรู้สึก:
   - `Low` = minor / easily worked around
   - `Medium` = has the potential to affect progress
   - `High` = serious problem that could block progress
   - `Highest` = will block progress
3. **ห้ามตั้ง priority จากอาการที่เห็นก่อน research** — KAN-227 ตั้ง `Medium`
   ตอนสร้าง แล้ว research เจอว่าวันถอด Node 20 ผ่านมาแล้ว 8 วัน ต้องเป็น `High`
   เขียนไว้ว่า "set severity after research, not before"
4. **Warning ที่ยังทำงานอยู่ ไม่ใช่ warning ที่ยังไม่สำคัญ** — ถ้ามันพึ่ง fallback
   ที่เจ้าของ platform ประกาศถอดแล้ว นั่นคือ unsupported ไม่ใช่ stable
5. บันทึกวันที่จริงจาก upstream ไม่เดา — deprecation notice มี timeline ที่
   อาจผ่านไปแล้ว ตรวจเสมอว่า "เตือนล่วงหน้า" หรือ "เลยกำหนดมาแล้ว"
6. **ไม่แก้ทันทีข้างงานอื่น** — ถ้าไม่ใช่ scope ที่อนุมัติ ให้บันทึกเป็น ticket
   พร้อมรายละเอียดและ reference ไปยัง run ที่เจอ แล้วค่อยกลับมาทีหลัง

ตัวอย่างที่ทำให้กฎนี้มีจริง: 2026-10-01 deploy run พิมพ์ Node 20 deprecation +
ubuntu-latest migration → ได้ KAN-227 (High) และ KAN-228 (Medium)
