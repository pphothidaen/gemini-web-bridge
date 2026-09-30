# HoroConsultant governance (when opening the HoroConsultant folder)

- ทุก ticket: test-first — commit 1 = tests + manifest (`plans/test_provenance/`),
  commit 2 = source; แยก source/test ออกจากกันเด็ดขาด (pre-commit guard)
- `ticket_id` ใน manifest ต้องขึ้นต้น `TICKET-`; `baseline_parent` = HEAD จริง;
  `supersedes` ต้องเป็น full SHA
- รัน: `.venv/bin/python -m pytest <target> -q`
- ก่อน release: `.venv/bin/python scripts/sync_ai_agent_ecosystem.py --check` ต้อง exit 0
- ทุก commit: `KAN-<id>: <description>` — ยืนยัน ticket มีจริงด้วย
  `source ~/.zshrc && twg jira workitem get KAN-<id>` ก่อน cite เสมอ
- ห้าม print/log secret (G1 Zero-Token-Leak) — ดึง secret สดด้วย Doppler เสมอ
- fail-closed เสมอ: gate ที่อ่าน Jira/external oracle ไม่ได้ ต้องไม่ตีความว่า "ผ่าน"
