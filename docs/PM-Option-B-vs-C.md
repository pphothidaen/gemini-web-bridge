# 📋 PM Report: Option B (Shared Catalog const) vs Option C (Worker-Led Registry)

**System:** gemini-web-bridge — Chrome extension bridges Gemini web UI → Cloudflare Worker via WebSocket. Current impl: extension discovers models from Gemini DOM → sends `SESSION_READY`/`MODELS_DISCOVERED` → Worker stores in DO memory (`dynamicModels`, `catalogRevision`).

**Decision axis:** Where does the *authoritative model catalog* live when adding new models?

---

## 1. User Experience Impact / ผลกระทบต่อผู้ใช้

| Dimension | Option B — Shared Catalog const | Option C — Worker-Led Registry |
|---|---|---|
| **New model visibility** | ❌ User must reload Chrome tab (or restart) to get updated extension JS. If auto-refresh on token expiry is the only trigger, user may wait hours. | ✅ Extension fetches catalog on connect. New models appear after a WebSocket reconnect — no tab reload, no extension update. |
| **Model list accuracy** | ⚠️ Catalog drifts from Gemini's actual available models over time. Users see stale model names. | ✅ Worker can be updated independently; catalog stays current with Gemini's offerings. |
| **Connection resilience** | ✅ Catalog is local — works even if Worker is briefly unreachable during initial connect. | ❌ Extension depends on Worker availability to fetch catalog. If Worker is down, no models → degraded experience. |
| **Per-machine variance** | ✅ All users see the same catalog (consistent). | ✅ Worker can serve different catalogs per scope/tenant if needed (flexibility). |

**UX Verdict:** Option C wins for freshness; Option B wins for resilience. The current hybrid (DOM discovery → Worker store) is actually better than both for accuracy but couples catalog to Gemini UI.

---

## 2. Time-to-Market for Adding New Models / ระยะเวลาเพิ่มโมเดลใหม่

| Step | Option B | Option C |
|---|---|---|
| 1. Add model entry | Edit `GEMINI_MODEL_CATALOG` in extension source | Update Worker KV/DO or config endpoint |
| 2. Rebuild | `npm run build` + repackage extension zip | No rebuild |
| 3. Redeploy | Update Chrome extension (git push + CD) | `wrangler deploy` or KV put |
| 4. User impact | Chrome reload required (auto or manual) | Next WebSocket reconnect picks it up |
| **Total TTM** | **~15–30 min** (build + CD + reload) | **~2–5 min** (Worker deploy only) |

**TTM Verdict:** Option C is 3–6× faster. No build pipeline, no extension packaging, no waiting for CD gate.

---

## 3. Operational Complexity — Chrome Reload Frequency / ความซับซ้อนเชิงปฏิบัติการ

| Scenario | Option B | Option C |
|---|---|---|
| **Token expiry** | Auto-reload triggers extension re-init → catalog re-read from new JS | Auto-reload triggers reconnect → catalog re-fetched from Worker |
| **New model added** | Requires tab reload to pick up new extension JS | No reload needed — next reconnect |
| **Extension update** | Full Chrome extension update cycle (git → build → zip → CD → Chrome reload) | Not needed for model changes |
| **Reload frequency** | High — every model addition = reload | Low — only on token expiry or extension code change |

**Ops Verdict:** Option C decouples model updates from extension lifecycle. Users reload less often.

---

## 4. Developer Maintenance Burden / ภาระการบำรุงรักษาสำหรับนักพัฒนา

| Task | Option B | Option C |
|---|---|---|
| Add/remove model | Edit source → build → test → deploy → verify | Edit KV/config → deploy → verify |
| Catalog validation | Build-time (tests) | Runtime (Worker can validate against Gemini) |
| Rollback | Revert source → full redeploy | Revert KV/config → instant |
| Catalog versioning | Git history only | Can version in KV with metadata |
| Test surface | Extension unit tests + Worker contract tests | Worker-only tests (smaller surface) |
| Coupling | Catalog coupled to extension release | Catalog independent of extension release |

**Maintenance Verdict:** Option C reduces the change surface from "extension + Worker" to "Worker only." Less build tooling, faster iteration.

---

## 5. Scalability to 10+ Models / การขยายสู่ 10+ โมเดล

| Concern | Option B | Option C |
|---|---|---|
| **Payload size** | Catalog ships in extension JS (few KB, fine at 10–20 models) | Catalog fetched at runtime (same size, but over network) |
| **Sorting/filtering** | Hardcoded in extension | Worker can sort/filter dynamically per request |
| **Model metadata** | Fixed schema in source | Can evolve schema in Worker without extension update |
| **Per-model config** (thinking effort, etc.) | Must be in source | Worker can serve rich metadata |
| **10–20 models** | ✅ Fine | ✅ Fine |
| **50+ models** | ⚠️ JS bundle bloat, but still fine | ✅ Worker can paginate/filter |

**Scalability Verdict:** Both handle 10+ models. Option C is cleaner for rich per-model metadata and dynamic filtering. Option B starts to feel cramped if models need per-model prompts, system instructions, or capability flags.

---

## 6. Auto-Refresh UX / ประสบการณ์ผู้ใช้เมื่อรีเฟรชอัตโนมัติ

This is the **most critical differentiator** for user perception.

### What happens on auto-refresh (token expiry):

| Aspect | Option B | Option C |
|---|---|---|
| **Tab reload?** | Yes — extension JS re-executes | Yes — same mechanism |
| **Conversation context** | ❌ **Lost.** Tab reload destroys Gemini's in-memory conversation. User must start a new chat. | ❌ **Lost.** Same — tab reload is tab reload. |
| **Model list after reload** | Read from new extension JS (may be stale) | Fetched from Worker on reconnect (always current) |
| **User awareness** | May notice brief flash / loading spinner | Identical UX — brief flash / loading spinner |
| **Bridge session** | New WebSocket → new `catalogRevision` | New WebSocket → new `catalogRevision` |

### Key insight:
> **Auto-refresh UX is identical for both options** because the refresh mechanism (tab reload on token expiry) is orthogonal to where the catalog lives. The difference is *what catalog the extension sees after reload* — Option B sees the baked-in list (potentially stale), Option C sees the Worker's current list (fresh).

### Conversation context loss — deeper analysis:

| Aspect | Detail |
|---|---|
| **Root cause** | Gemini web UI stores conversation state in the page's memory (JavaScript context). A tab reload destroys it. |
| **Option B vs C** | **Identical** — both trigger the same `chrome.tabs.reload()` → same context loss. |
| **Mitigation (either option)** | 1. Use Gemini's "Share link" or "Export" before token expires. 2. Bridge could snapshot conversation to DO before reload (not currently implemented). 3. Reduce token expiry frequency by refreshing tokens proactively. |
| **User perception** | Users will perceive a brief interruption (~2–5s for reload + reconnect). Conversation loss is the pain point, not the model list. |

### Auto-refresh timing considerations:

| Timing | UX Impact |
|---|---|
| **Refresh during active typing** | ❌ Worst — user loses input focus and conversation. |
| **Refresh during idle** | ✅ Best — user likely not actively typing. |
| **Refresh during streaming** | ❌ Disruptive — partial response lost. |
| **Refresh + reconnect** | Brief spinner, then back to normal. User may not notice if <3s. |

### Recommendation for auto-refresh UX:

1. **Add a pre-reload warning** (extension badge change or subtle notification) so users can finish their thought.
2. **Snapshot conversation to DO** before reload — allow "Restore conversation" on reconnect.
3. **Refresh during idle** — detect no typing for 30s, then trigger reload.
4. **Show a "Reconnecting…" overlay** during the reload+reconnect window so users understand what's happening.

**Auto-Refresh Verdict:** Both options have the same auto-refresh UX challenge. The differentiator is post-reload freshness: Option C gives users the current model list, Option B may give a stale list. Conversation context loss is a shared problem needing a separate solution.

---

## 7. Comparative Summary / สรุปเปรียบเทียบ

| Criterion | Option B (Shared Catalog) | Option C (Worker-Led) | Winner |
|---|---|---|---|
| **UX freshness** | Stale until reload | Always current | **C** |
| **Resilience** | Works offline (catalog local) | Requires Worker up | **B** |
| **Time-to-market** | 15–30 min | 2–5 min | **C** |
| **Chrome reload freq** | High | Low | **C** |
| **Maintenance burden** | Extension + Worker | Worker only | **C** |
| **Scalability (10+)** | Fine | Fine (better for rich metadata) | **C** |
| **Auto-refresh UX** | Same (context lost) | Same (context lost) | **Tie** |
| **Rollback speed** | Full redeploy | Instant | **C** |
| **Coupling** | Catalog ↔ extension release | Catalog independent | **C** |

---

## 8. Recommendation / ข้อแนะนำ

### Short-term (current state):
The current **hybrid approach** (DOM discovery → Worker store) is the most accurate but couples the catalog to Gemini's UI. This is acceptable for 3–5 models but won't scale.

### Medium-term (recommended):
**Adopt Option C (Worker-Led Registry)** with these safeguards:

1. **Worker serves catalog at `/v1/models` or via WebSocket handshake** — extension fetches on connect.
2. **Extension falls back to a minimal built-in catalog** if Worker is unreachable (hybrid resilience).
3. **Catalog stored in Cloudflare KV** (not DO memory) — persists across DO hibernation, faster to update.
4. **Version the catalog** — extension sends `catalogRevision` to avoid redundant updates.
5. **Add a "Refresh models" button** in extension popup — lets users pull latest without tab reload.

### Long-term (if model count grows):
- **Per-model configuration** (system prompts, thinking effort, tool allowlist) in Worker catalog.
- **Dynamic model enable/disable** based on user tier or A/B testing.
- **Catalog health monitoring** — Worker validates models against Gemini API periodically, removes stale entries.

### Risk mitigation for Option C:

| Risk | Mitigation |
|---|---|
| Worker down → no models | Fallback to minimal built-in catalog (5 core models) |
| Catalog fetch latency | Cache in extension `chrome.storage.session` (survives reload, cleared on browser close) |
| Schema evolution | Version catalog API; extension ignores unknown fields |
| Worker deploy breaks catalog | Health check endpoint monitors catalog integrity; auto-rollback on failure |

---

## 9. Decision Matrix for Stakeholders / เมตริกกัสำหรับผู้มีส่วนได้ส่วนเสีย

| Stakeholder | Preferred Option | Rationale |
|---|---|---|
| **End users** | C | Fresh models without reload |
| **DevOps/SRE** | B (with C fallback) | Fewer moving parts, catalog always available |
| **Developers** | C | Faster iteration, smaller change surface |
| **Product** | C | Scales to 10+ models, better UX |
| **Security** | Tie | Neither stores secrets; both use existing auth |

### Final recommendation:
**Option C (Worker-Led Registry) with Option B fallback.** This gives the best of both worlds: freshness and fast iteration when Worker is up, resilience when it's down. The auto-refresh UX challenge (conversation context loss) is orthogonal and should be addressed separately.

---

*Report generated: 2026-10-17*
*Author: PM Agent (subagent)*
*System: gemini-web-bridge v4.4.3*
