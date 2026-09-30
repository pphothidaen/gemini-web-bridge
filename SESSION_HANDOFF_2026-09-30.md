# Session Handoff — Cline Onboarding + Bridge Auth Rotation (gemini-web-bridge)

**Session date:** 2026-09-30
**Working dirs:** `/Users/kimlenglim/Project/gemini-web-bridge`, `/Users/kimlenglim/Project/HoroConsultant`
**Branches:** both on `main`, clean, synced with origin
**Tickets:** KAN-214 … KAN-219 — all `Done`

---

## สถานะปัจจุบัน (verified live)

| ระบบ | สถานะ |
|---|---|
| Worker version | **4.7.21** deployed to production |
| Chrome extension | **CONNECTED_AND_READY**, model `3.8 Flash`, `consecutive_errors: 0` |
| MCP tools | 9 (`tools/list` → HTTP 200) |
| gemini-web-bridge | `05a5439` clean, synced |
| HoroConsultant | `28425f30` clean, synced, **0 open PRs** |
| Cline config | `cline_mcp_settings.json` mode `600`, canonical host |

**Canonical host:** `https://prod.gemini-web-bridge.workers.dev`
**Stale host (do NOT use):** `gemini-web-bridge.pansakorn-pho.workers.dev` — v4.4.3, DISCONNECTED. Left as a rollback target by the account migration in `fa97a5d`. It still returns 200 and still lists 9 tools, so **a wrong host fails silently** — only the `version` in `/health` reveals it.

---

## สิ่งที่ทำใน session นี้

### 1. Cline + remote MCP (KAN-214, KAN-217)
- ติดตั้ง Cline v4.1.22 (`saoudrizwan.claude-dev`) — ยังไม่มีในเครื่องตอนเริ่ม
- เขียน `cline_mcp_settings.json` ที่ globalStorage path (mode 600, นอก repo)
- `.clinerules/` 3 ไฟล์ — `01-governance.md`, `02-bridge-api.md` (gemini-web-bridge) และ `03-horoconsultant-repo.md` (HoroConsultant)

**แก้ในคู่มือเดิม 4 จุด** — ทั้งหมดพิสูจน์จากการรันจริง ไม่ใช่เดา:

| คู่มือเดิม | ของจริง |
|---|---|
| `alwaysAllow` | ต้องเป็น **`autoApprove`** — Cline ignore `alwaysAllow` ทิ้งเงียบ ๆ |
| `doppler secrets get X --config prd` | ต้องมี **`--project gemini-web-bridge`** ด้วย ไม่งั้น fail |
| `CLIENT_API_KEY` อยู่ใน Doppler `prd` | **ไม่มี** — `prd` มีแค่ `BRIDGE_SECRET` + meta. ค่าที่ใช้ได้อยู่ใน `.env` ที่ gitignored |
| `source ~/.zshrc &&` นำหน้า twg | **ไม่จำเป็น** — `twg` auth จาก `~/.config/twg/auth.conf` ทำงานได้แม้ env ว่างเปล่า (พิสูจน์ด้วย `env -i`) |

### 2. Docs-only exemption — ผิดทางที่คิด (KAN-215 → Done/won't-fix)
คิดว่าเป็น hook bug แต่ `test_mixed_range_is_strict_even_when_head_commit_is_docs_only` **ผ่าน** และ docstring ระบุเจตนาชัด: range-wide เป็น design ที่ตั้งใจ fail-closed **การแก้ที่เสนอจะอ่อน governance controlลง** เพื่อเอา commit ที่ผม bundle ผิดเอง → ปิด ticket + comment แจ้งว่าผิด

### 3. Rename + rotate credential (KAN-219) — 5 commits
`BRIDGE_SECRET` → **`BRIDGE_AUTH_TOKEN`** ทั้ง worker binding, extension placeholder, build script, wrangler configs, CI/CD, 18 test fixtures

**bug จริง 2 จุดที่จับได้ระหว่างทำ** (ทั้งคู่จะ ship ถ้าไม่เช็ค):
- `cd.yml` อ่าน `$BRIDGE_SECRET` แต่ env block เปลี่ยนชื่อไปแล้ว → จะ pipe **ค่าว่าง** ใส่ production binding (silent wipe ไม่ใช่ error)
- blanket rename เขียนทับ *negative assertions* ในเทสต์ตัวเองเป็นข้อขัดแย้ง → เทสต์ 5 ตัวผ่าน "ด้วยเหตุผลผิด"

**หมายเหตุ:** macOS `sed` ไม่รองรับ `\b` — รอบแรกเหลือ undefined variable 7 จุดใน `index.js` จับก่อน commit

### 4. KAN-218 — pre-push range bug (PR #122 merged)
`git rev-list <sha> --not --remotes` หักอะไรไม่ได้เลยสำหรับ branch ที่ยังไม่มีบน remote → range กลายเป็น local history ทั้งหมด → รายงาน fail ของ KAN-67/68/70/71/183 ที่ไม่ได้อยู่ใน push

**พิสูจน์แล้วว่าแก้จริง:** push branch จริง → validate 1 commit, ไม่มี phantom failure

**หมายเหตุสำหรับ debug:** `git push --dry-run` **ไม่ reproduce** range math ของ hook — dry-run เดิมได้ 259 commits ทั้งที่ push จริงได้ถูกต้อง

---

## ⚠️ สิ่งที่ยังค้าง / ต้องรู้

### ต้องระวัง
1. **`gemini-bridge-*` format ถูก CI ห้ามเด็ดขาด**
   `extension-secrets.test.mjs:29` → `/hermes-[a-f0-9]{16,}|gemini-bridge-[a-f0-9]{16,}/`
   มีอยู่เพราะ token เก่า leak ออก public repo — guard นี้จับได้จริง
   *(ค่า credential ปัจจุบันใช้ prefix นี้ตามที่ผู้ใช้เลือก — ปลอดภัยตราบใดที่ไม่หลุดเข้า tracked file; `release/` ถูก gitignore แล้วใน `713a06b` เพื่อปิดช่องนี้)*

2. **CD deploy จาก Doppler `prd_worker` ไม่ใช่ `prd`** — ต้องมีค่าให้ตรงกันทั้งสอง config

3. **Doppler CLI เพี้ยน:** `doppler secrets set A B C` + stdin หลายบรรทัด → กินหมดไปหมดเดียว ต้องทำทีละ key

4. **`worker-configuration.d.ts` gitignored** — ถูก regenerate ตอน deploy ต้องมีชื่อ binding ใหม่

### ยังไม่ได้ทำ (นอก scope ที่อนุมัติ)
- **`PHASE_PROGRESS.md` + 6 ไฟล์** untracked ใน gemini-web-bridge — เป็น Phase 2/4 workstream แยก (`sandbox.ts`, `guardrail.ts`, `search-proxy.ts`, `sandbox-server.js`, 2 tests) **ยังไม่มี ticket** ผมเคย commit ผิดด้วย `git add -A` แล้วแยกออกมาแล้ว
- **`stash@{0}`** ใน HoroConsultant (`pre-rebase-kan214-wip`, 5 ไฟล์) — **มีอยู่ที่เดียว** กู้ด้วย `git stash pop`
- **`horo_consult` ยังไม่เคยเรียกจริง** — ต้องมี birth_context และ G-9 fail-closed discipline gate บังคับ ผมไม่รันเองเพราะเป็นการส่งข้อมูลเกิดจริง

---

## คำสั่งที่ใช้บ่อย

```bash
# production health (เช็คว่า ext ออนไลน์ + version ตรง)
curl -s https://prod.gemini-web-bridge.workers.dev/health | python3 -m json.tool

# rebuild extension (ต้องหลัง rotate token — 4.7.20 เก่า 401)
python3 scripts/build-extension.py --set-version <v> --verify
# → โหลดที่ dist/extension (relative path จาก extension.config.json)

# worker tests
cd cloudflare-worker && npm test

# Jira oracle (ไม่ต้อง source ~/.zshrc)
twg jira workitem get KAN-<id>
```

**Chrome:** `chrome://extensions` → Load unpacked → `dist/extension` → reload แท็บ `gemini.google.com`
*ถ้าโหลดแล้วยัง DISCONNECTED: reload extension แล้วต้อง reload แท็บด้วย ไม่งั้น `SESSION_READY` ไม่ยิง*

---

## กฎที่ต้องจำ (repo นี้)

- ทุก commit ขึ้นต้น `KAN-<id>:` และ **ยืนยัน ticket มีจริงก่อน cite** — `docs/COMMIT_TICKET_MAPPING.md` มีกรณี "predicted key" ที่พังไปแล้ว
- hooks ที่ `.githooks` (`core.hooksPath`): `commit-msg` เช็ค format, `pre-push` ถาม Jira
- ห้าม log secret (G1) — ดึงสดด้วย `doppler secrets get <NAME> --project gemini-web-bridge --config prd_worker`
- **HoroConsultant:** test-first 2 commit (tests+manifest → source), `main` เป็น PR-only + required check `Test Provenance` (ruleset `24074067`)
  - ต้องมี manifest `plans/test_provenance/*.json` มี `TICKET-` prefix — docs-only ไม่ต้องมี (มี exemption)
  - `.clinerules/03-horoconsultant-repo.md` มีกฎนี้