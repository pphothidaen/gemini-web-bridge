# 📋 Gemini Web Bridge — Work Plan & Task Status

> **Project:** gemini-web-bridge (Cloudflare Worker v4.3.4)
> **Created:** 2026-09-21
| **Status:** All fixes complete ✅, 95/95 tests PASS ✅, Deployed ✅, Route sync complete ✅
| **Bridge Server Status:** All 40 Rust gateway routes in sync with Python OpenAPI ✅ (PR #61)
| **NotebookLM Channel:** `https://gemini.google.com/notebook/b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0` — HoroConsultant งาน bridge server routing sync
> **Production URL:** https://gemini-web-bridge.pansakorn-pho.workers.dev

---

## 1. วัตถุประสงค์

เอกสารนี้สรุปสถานะงานปัจจุบันของ gemini-web-bridge project โดยเฉพาะ:
- งานที่เสร็จสิ้นแล้ว (รวม P0 security fix)
- Tests ที่ยังล้มเหลวและเหตุผล
- แผนการแก้ไข tests ที่เหลือ
- ขั้นตอน deployment

---

## 2. งานที่เสร็จสิ้นแล้ว (Completed)

### ✅ P0 Security Fix — URL Credential Leak Prevention (2026-09-21)

**ปัญหา:** `/v1/models` และ `/models` ถูกจัดอยู่ใน `publicPaths` array ใน `src/index.js:675` ทำให้ endpoint เหล่านี้ไม่มีการตรวจสอบ auth — credential ที่ส่งผ่าน URL query parameters (`?api_key=`, `?token=`, `?bearer=`) ถูกปล่อยผ่านโดยไม่ตรวจสอบ

**การแก้ไข:** ถอด `/v1/models` และ `/models` ออกจาก `publicPaths` array ใน `src/index.js:675` ทำให้ endpoint เหล่านี้ต้องตรวจสอบ Bearer token authentication ก่อนเข้าถึง

**ผลลัพธ์:** ยืนยันผ่าน RED TEAM test — credential ใน URL query ตอนนี้ได้รับ HTTP 401 ✅

**File ที่แก้:** `cloudflare-worker/src/index.js` (line 675)

---

## 3. สถานะ Test ปัจจุบัน

**ผลรวม (2026-09-21):** ~~90 passed, 6 failed (จาก 96 tests)~~ → **95 passed, 0 failed (จาก 95 tests) ✅**

### Tests ที่ผ่าน ✅
- ทุก Unit tests (64 tests)
- ทุก Red Team tests (24 tests) — รวมถึง P0 security test
- MCP Protocol tests (ส่วนใหญ่) — ยกเว้น test #8 (version mismatch)
- Integration tests บางส่วน — ยกเว้น tests 1, 2, 4, 5, 6, 7

### Tests ที่ยังล้มเหลว ❌ (6 tests)

> **✅ UPDATE (2026-09-21): ทุก test ถูกแก้ไขเรียบร้อยแล้ว — 95/95 PASS, 0 failures**

| # | Test ชื่อ | ไฟล์ | สาเหตุ | หมวด |
|---|---|---|---|---|
| 1 | `GET /health returns status ok` | `integration.test.mjs:48` | ปัจจุบัน `/health` response ไม่มี field `protocolVersion` — test คาดหวัง field ที่ไม่มี | test_bug |
| 2 | `GET /bridge/status returns worker status` | `integration.test.mjs:87` | endpoint `/bridge/status` **ไม่มีจริง**ใน production — path ผิดมาตั้งแต่เดิม | test_bug |
| 3 | `WebSocket upgrade succeeds` | `integration.test.mjs:134` | WebSocket connection error ใน test environment — ต้องการ token + extension connected | env_issue |
| 4 | `POST /bridge/chat rejects empty messages` | `integration.test.mjs:172` | path ผิด — ควรทดสอบ `/v1/chat/completions` ไม่ใช่ `/bridge/chat` | test_bug |
| 5 | `POST /bridge/chat rejects malformed JSON` | `integration.test.mjs:181` | path ผิด — ควรทดสอบ `/v1/chat/completions` ไม่ใช่ `/bridge/chat` | test_bug |
| 6 | `MCP Protocol: initialize returns version` | `mcp-protocol.test.mjs:163` | Test คาดหวัง version `4.3.2` แต่ server รายงาน `4.3.4` — stale test | prod_issue |

---

## 4. แผนการแก้ไข Tests (Fix Plan)

### P1 — แก้ tests ที่เหลือ (Prioritized)

| Priority | Test | การแก้ไข | ไฟล์ |
|---|---|---|---|
| P1 | Test #2: `/bridge/status` | **ลบ test นี้ออก** — endpoint ไม่มีจริง ไม่สามารถ fix ได้ | `integration.test.mjs:86-90` |
| P1 | Test #4: `/bridge/chat rejects empty` | เปลี่ยน path `/bridge/chat` → `/v1/chat/completions` + เพิ่ม auth token + แก้ body format | `integration.test.mjs:163-169` |
| P1 | Test #5: `/bridge/chat rejects malformed` | เปลี่ยน path `/bridge/chat` → `/v1/chat/completions` + เพิ่ม auth token | `integration.test.mjs:171-178` |
| P2 | Test #6: `/bridge/chat sends message` | เปลี่ยน path `/bridge/chat` → `/v1/chat/completions` + แก้ body format (messages, model) | `integration.test.mjs:143-159` |
| P1 | Test #1: `/health protocolVersion` | ลบ assertion `protocolVersion` (field ไม่มีใน response) หรือเพิ่ม field ใน production | `integration.test.mjs:48` |
| P2 | Test #3: WebSocket | ใส่ token ใน WebSocket URL (`?token=...`) + จัดการกรณีไม่มี token (skip) | `integration.test.mjs:94-139` |
| P3 | Test #8: MCP version | อัปเดต hardcoded `4.3.2` → `4.3.4` ใน test assertion | `mcp-protocol.test.mjs:163` |

### ลำดับการ execute

```
ขั้นที่ 1: patch test files (integration.test.mjs + mcp-protocol.test.mjs)
ขั้นที่ 2: รัน make test เพื่อยืนยัน
ขั้นที่ 3: ถ้าผ่าน — ทำ deployment
ขั้นที่ 4: ถ้าไม่ผ่าน — แก้ไขต่อ
```

---

## 5. สถานะ Deployment

**ปัจจุบัน:** ✅ Production deployed with all fixes (Version 50f011af, 2026-09-21)

**Deploy หลังแก้ tests:**
```bash
# 1. ตรวจสอบ lint
make lint

# 2. ตรวจสอบ health
make health

# 3. Deploy (ต้องมี Cloudflare API token)
make deploy
```

**เงื่อนไขก่อน deploy:**
- [x] Tests ทั้ง 6 fixed แล้ว และรันผ่าน (95/95 PASS)
- [x] Lint ผ่าน
- [x] Health check ผ่าน

---

## 6. สรุป Priority Work

| Priority | งาน | สถานะ | คาดว่าเสร็จ |
|---|---|---|---|
| ✅ P0 | Security fix (publicPaths) | **เสร็จ + ยืนยัน** | 2026-09-21 |
| ✅ P1 | Fix tests #1, #2, #4, #5, #6, #7, #8 | **เสร็จ — 95/95 PASS** | 2026-09-21 |
| 🟡 P2 | Deploy production (หลัง tests ผ่าน) | **✅ Deployed — Version 50f011af** | 2026-09-21 |
| ✅ P3 | WebSocket test (ถ้าแก้ไม่ได้ ให้ xfail) | **Skip เมื่อไม่มี CF_TOKEN** | 2026-09-21 |

---

## 7. ไฟล์สำคัญ

| ไฟล์ | หน้าที่ | สถานะ |
|---|---|---|
| `cloudflare-worker/src/index.js` | Production code — P0 fix แล้ว | ✅ แก้แล้ว |
| `cloudflare-worker/tests/integration.test.mjs` | Integration tests — 6 tests ล้มเหลว | ❌ ต้องแก้ |
| `cloudflare-worker/tests/mcp-protocol.test.mjs` | MCP protocol tests — 1 test ล้มเหลว (version) | ❌ ต้องแก้ |
| `cloudflare-worker/tests/red-team-adversarial.test.mjs` | Red team tests — ทั้งหมดผ่าน | ✅ OK |
| `HANDOFF.md` | Project handoff document — อัปเดตแล้ว | ✅ อัปเดต |
| `plan.md` | เอกสารนี้ — สร้างเมื่อ 2026-09-21 | ✅ สร้าง |
| `cloudflare-worker/.env` | Local secrets (ห้าม commit) — ใช้ Doppler สำหรับ team/production | ⚠️ .gitignore |

---

## 9. งานเสร็จสมบูรณ์ — Bridge Server Route Sync (2026-09-21)

| งาน | สถานะ | รายละเอียด |
|---|---|---|
| P0 | Security Fix (publicPaths) | ✅ เสร็จ + ยืนยัน |
| P1 | Rust Gateway Route Sync | ✅ เสร็จ — 40 routes เพิ่มใน `route_kind()` |
| P1 | Contract Test (Rust↔Python) | ✅ 5 tests pass |
| P1 | Test Provenance Manifest | ✅ Schema v1 JSON |
| P1 | Pre-commit Gates | ✅ Source/test commit 分開 |
| P2 | CI Integration | ✅ ci.yml + DoD gate |
| P2 | Post-deploy Smoke Test | ✅ deploy-render.yml |

**Root cause**: Rust `horo_server` มี closed allowlist routing table ไม่อัปเดต — routes ใหม่ใน Python ถูก 404

**Fix**: เพิ่ม 40 routes (รวม `/admin/provider-pools`, `/api/v3/health`, `/bazi/interpret`) ใน `route_kind()` + dynamic pattern matching

**Evidence**: `tests/test_route_sync.py` (5 contracts pass) → `cargo test` 7/7 pass

**PR**: https://github.com/pphothidaen/HoroConsultant/pull/61

---

## 8. ขั้นตอนต่อไป (Next Actions)

1. ~~**ทันที:** แก้ test files 6 tests ตามแผนในส่วน 4~~ ✅ เสร็จ
2. ~~**หลัง patch:** รัน `make test` เพื่อยืนยัน~~ ✅ 95/95 PASS
3. ~~**ถ้าผ่าน:** รัน `make lint && make health` แล้ว deploy~~ ✅ Deployed Version 50f011af
4. **อัปเดต:** อัปเดต HANDOFF.md อีกครั้งเมื่อ tests ทั้งหมดผ่าน ✅ Done
5. **HoroConsultant:** ใช้ NotebookLM channel `b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0` (`https://gemini.google.com/notebook/b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0`) สำหรับงานต่อ ๆ ไป รวมถึงการสนับสนุน pattern `https://gemini.google.com/notebook/{notebook-id}` สำหรับ notebook ใหม่ ๆ
