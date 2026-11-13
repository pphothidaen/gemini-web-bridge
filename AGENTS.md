# AGENTS.md — gemini-web-bridge Compact Gateway

## 1. Non-Negotiable Constraints
- **Read-Before-Modify:** Always read target files and `docs/architecture.md` before editing.
- **No Speculative Coding:** Modify only files scoped to the active Ticket/ADR.
- **Tier 3 Governance:** Changes to `cloudflare-worker/src/**` or `dist/extension/**` require an approved ADR in `docs/adr/` and E3 HITL Review (`cross_functional_review.py`).
- **Iteration Safety Cap:** Max 5 retries or 3 identical failing actions before escalating to Human.

## 2. Architecture & ADR Navigation
- **Visual Architecture (Mermaid):** `docs/architecture.md`
- **ADR-0001 (Durable Objects Bridge):** `docs/adr/0001-cloudflare-durable-objects-bridge.md`
- **ADR-0002 (Multi-Session Load Balancing):** `docs/adr/0002-multi-session-load-balancing.md`
- **ADR-0003 (Context Persistence D1/Vectorize):** `docs/adr/0003-context-persistence-vector-memory.md`
- **ADR-0004 (Session Health Recovery):** `docs/adr/0004-session-health-auto-recovery.md`

## 3. HITL Governance (Local + CI)
- **E3 Decision Gate:** `~/.hermes/scripts/cross_functional_review.py`
- **Self-Bypass Prevention (KAN-313):** Integrated in `make_decision()` — agent roles cannot self-approve
- **Telemetry:** `~/.hermes/scripts/review_telemetry.py` (SQLite WAL + JSONL)
- **Webhook Alerting:** `~/.hermes/scripts/notify_webhook.py` (Discord/Slack via `HERMES_WEBHOOK_URL`)
- **CI Gate:** `.github/workflows/hitl-pr-gate.yml` (ADR baseline + Tier 3 ticket enforcement)

## 4. Third-Party & App Services (Free Tier Only)
| Service | Tier | Purpose |
|---------|------|---------|
| Cloudflare Workers | Free | API Gateway, Durable Objects |
| GitHub Actions | Free | CI/CD, PR gating |
| Grafana + Loki | Free (self-hosted, `~/.hermes/monitoring/`) | Dashboards, alerting |
| Discord / Slack Webhook | Free | HITL gate alerts, edge session alerts |
| Doppler (`prd_worker`) | Free | Secret management |
| SQLite WAL | Free | Telemetry DB, gate events |

## 5. Quick Reference
- **Read:** `docs/architecture.md` before any architecture change
- **ADR Check:** `find docs/adr -maxdepth 1 -name "00*.md"` (expect ≥ 4)
- **HITL Test:** `python3 ~/.hermes/scripts/cross_functional_review.py --help`
- **Webhook Test:** `HERMES_WEBHOOK_URL=<url> python3 ~/.hermes/scripts/notify_webhook.py`
