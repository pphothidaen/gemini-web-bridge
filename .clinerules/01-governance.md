# Project Governance (gemini-web-bridge)

- อ่าน GUARDRAILS.md (G1-G5) และ docs/api-spec.md (invariants G-1..G-9) ก่อนแตะโค้ดทุกครั้ง
- ทุก commit: `KAN-<id>: <description>` — ยืนยัน ticket มีจริงด้วย
  `twg jira workitem get KAN-<id>` ก่อน cite เสมอ
  (ห้ามเดาเลข ticket — ดู docs/COMMIT_TICKET_MAPPING.md)
- hooks ใน repo นี้บังคับอยู่แล้ว (`core.hooksPath=.githooks`):
  - `commit-msg` ตรวจรูปแบบ `KAN-<id>:` ในบรรทัดแรก
  - `pre-push` ถาม Jira ว่า ticket ที่ cite มีอยู่จริงไหม (fail-closed เมื่อ Jira ตอบว่าไม่มี)
- ห้าม print/log BRIDGE_SECRET, CLIENT_API_KEY, SNlM0e (G1 Zero-Token-Leak)
  - อย่า commit secret ลง `.clinerules/` — ไฟล์นี้อยู่ใน git
  - ดึง secret สดด้วย `doppler secrets get <NAME> --project gemini-web-bridge --config prd`
- ห้าม TODO/FIXME/HACK/XXX/BLOCKER ใน cloudflare-worker/src/ และ extension-cloudflare/ (G4.1.1)
  - งานค้างให้บันทึกใน PLANNING-HANDOFF.md เท่านั้น
- ก่อน push: `cd cloudflare-worker && npm test` ต้องผ่าน 0 fail
- fail-closed เสมอ: gate ที่อ่าน Jira/external oracle ไม่ได้ ต้องไม่ตีความว่า "ผ่าน"
