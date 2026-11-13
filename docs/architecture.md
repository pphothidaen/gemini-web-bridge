# Gemini Web Bridge — System Architecture (Mermaid Diagrams)

> เอกสารนี้รวมแผนภาพสถาปัตยกรรมทั้งหมดของระบบ Gemini Web Bridge (v4.2.0) เขียนด้วย **Mermaid.js** รองรับการเรนเดอร์บน GitHub ฟรี ไม่ต้องติดตั้งเครื่องมือเพิ่ม
>
> spec รายละเอียดดูที่ `ARCHITECTURE.md`

---

## 1. C4 Component Diagram (ระดับระบบ)

```mermaid
graph TB
    subgraph Clients["AI Clients (HTTPS)"]
        A[Hermes Agent]
        B[Cursor]
        C[Cline]
        D[Claude Code]
        E[Python SDK]
    end

    subgraph Edge["Cloudflare Edge"]
        F[Cloudflare Worker<br/>gemini-web-bridge<br/>/v1 | /mcp | /bridge]
    end

    subgraph DO["Cloudflare Durable Objects"]
        G[GeminiBridgeDO<br/>Single Instance<br/>idFromName("global-bridge")]
        H[BridgeRouterDO<br/>Multi-Session<br/>idFromName("router")]
    end

    subgraph Extension["Chrome Extension (MV3)"]
        I[background.js<br/>Leader Tab]
        J[content.js]
        K[injected.js<br/>MAIN World]
    end

    subgraph Gemini["Google Gemini Web Session"]
        L[gemini.google.com/app<br/>Authenticated Session]
        M[NotebookLM<br/>Document-Grounded]
    end

    subgraph Fallback["GCP Hybrid Fallback"]
        N[GCP Vertex AI<br/>Optional Fallback]
    end

    Clients -->|Bearer Token<br/>CLIENT_API_KEY| F
    F --> G
    F --> H
    G <-->|WSS Protocol v2| I
    I --> J
    J --> K
    K -->|CSRF Token<br/>SNlM0e (MAIN world only)| L
    K -.->|Document Grounding| M
    G -.->|GCP Fallback<br/>GEMINI_API_KEY| N

    style Clients fill:#e1f5fe,stroke:#01579b
    style Edge fill:#fff3e0,stroke:#e65100
    style DO fill:#f3e5f5,stroke:#4a148c
    style Extension fill:#e8f5e9,stroke:#1b5e20
    style Gemini fill:#fce4ec,stroke:#880e4f
    style Fallback fill:#fff8e1,stroke:#f57f17
```

---

## 2. Sequence Diagram — SSE Streaming & WebSocket Handshake

```mermaid
sequenceDiagram
    autonumber
    participant Client as AI Client
    participant Worker as Cloudflare Worker
    participant DO as GeminiBridgeDO
    participant Ext as Chrome Extension
    participant Gemini as Gemini Web

    Client->>Worker: POST /v1/chat/completions<br/>Bearer Token
    Worker->>DO: idFromName("global-bridge")<br/>fetch(request)
    DO->>Ext: WSS Message<br/>(queue if busy)
    Ext->>Gemini: Inject prompt via<br/>injected.js (MAIN world)
    Gemini-->>Ext: SSE Token Stream
    Ext->>DO: Forward SSE chunks<br/>over WSS
    DO-->>Worker: Stream chunks<br/>FIFO concurrency=1
    Worker-->>Client: SSE Response<br/>text/event-stream

    note over Client,Gemini: Idle timeout 60s<br/>Disconnect grace ~15s<br/>Zero mocks — fail-closed if Ext offline
```

---

## 3. HITL & E3 Approval Flow

```mermaid
flowchart TD
    Start([Pull Request Opened]) --> Gate1{pre_dispatch.py}
    Gate1 -->|Ticket ID missing| Block1[❌ Block: KAN ticket required]
    Gate1 -->|Ticket OK| Gate2{cross_functional_review.py<br/>Phase 1: init}
    
    Gate2 --> Gate3{Phase 2: record-perspective<br/>4 roles: architect,<br/>tech-lead, red-team,<br/>business-owner}
    
    Gate3 --> Gate4{Phase 2.5: Confidence Check<br/>4-Factor Analysis<br/>score ≥ 0.75?}
    
    Gate4 -->|Score < 0.75| Gate5{Human Confidence Verification<br/>--approve-confidence}
    Gate4 -->|Score ≥ 0.75| Gate6{Phase 3: synthesize<br/>Trade-off Table}
    
    Gate5 -->|Approved| Gate6
    Gate5 -->|Rejected| Block2[❌ Block: Human review required]
    
    Gate6 --> Gate7{Phase 4: E3 Decision Gate<br/>Rationale ≥ 20 chars<br/>Rollback ≥ 30 chars<br/>Mitigations not empty}
    
    Gate7 -->|Fail| Block3[❌ Block: E3 Gate failures]
    Gate7 -->|Pass| Gate8{Risk Tier?}
    
    Gate8 -->|Tier 3| Gate9{Dual Sign-off<br/>Architect + Business Owner}
    Gate8 -->|Tier 1-2| Gate10{Single Approver<br/>Implementer / Tech Lead}
    
    Gate9 -->|Both signed| Gate11[✅ review_approved<br/>Telemetry logged]
    Gate9 -->|Missing| Block4[❌ Block: Tier 3 dual sign-off]
    
    Gate10 -->|Signed| Gate11
    Gate10 -->|Missing| Block5[❌ Block: Single approver missing]
    
    Gate11 --> Merge[GitHub PR Merge<br/>+ jira_sha_bind.py<br/>Commit Trailer]

    style Start fill:#e1f5fe
    style Gate11 fill:#c8e6c9,stroke:#1b5e20
    style Block1 fill:#ffebee,stroke:#b71c1c
    style Block2 fill:#ffebee,stroke:#b71c1c
    style Block3 fill:#ffebee,stroke:#b71c1c
    style Block4 fill:#ffebee,stroke:#b71c1c
    style Block5 fill:#ffebee,stroke:#b71c1c
    style Merge fill:#e8f5e9,stroke:#1b5e20
```

---

## 4. Deployment Architecture (Cloudflare Free Tier)

```mermaid
graph LR
    subgraph Dev["Development (Local)"]
        D1[localhost:3000<br/>Grafana + Loki<br/>Promtail]
        D2[~/.hermes/monitoring/<br/>Docker Compose]
        D3[SQLite WAL<br/>review_gates.db]
    end

    subgraph CI["CI/CD (GitHub Actions)"]
        C1[push to main]
        C2[wrangler deploy<br/>Cloudflare Workers]
        C3[Doppler<br/>prd_worker secrets]
        C4[.github/workflows/<br/>hitl-pr-gate.yml]
    end

    subgraph Prod["Production (Cloudflare Free)"]
        P1[prod.gemini-web-bridge.workers.dev]
        P2[Cloudflare Dashboard<br/>Workers & Pages]
        P3[Cloudflare WAF<br/>Rate Limiting Free Tier]
        P4[wrangler tail<br/>Worker Logs]
    end

    D1 -->|Metrics via JSONL| D3
    C1 -->|Tests pass| C2
    C2 -->|Secrets from| C3
    C4 -->|Gate check| C2
    C2 -->|Deploy to| P1
    P1 -->|Rate limit via| P3
    P1 -->|Logs via| P4
    P4 -->|Forward to| D1

    style Dev fill:#e3f2fd,stroke:#1565c0
    style CI fill:#fff3e0,stroke:#e65100
    style Prod fill:#e8f5e9,stroke:#1b5e20
```

---

## 5. Observability Stack (Free, Local Docker)

```mermaid
graph TD
    subgraph Sources["Data Sources"]
        S1[review_telemetry.py<br/>SQLite WAL + JSONL]
        S2[cross_functional_review.py<br/>E3 Gate events]
        S3[Cloudflare Worker<br/>wrangler tail logs]
        S4[GitHub Actions<br/>CI/CD logs]
    end

    subgraph Ingestion["Ingestion"]
        I1[Promtail<br/>Tail JSONL files]
        I2[Grafana Agent<br/>Optional alternative]
    end

    subgraph Storage["Storage (Local)"]
        St1[Loki<br/>Port 3100<br/>Log aggregation]
        St2[Prometheus<br/>Metrics scrape]
        St3[SQLite WAL<br/>review_gates.db<br/>ai_sdlc_metrics.db]
    end

    subgraph Visualization["Visualization"]
        V1[Grafana<br/>Port 3000<br/>Dashboards + Alerting]
    end

    subgraph Alerting["Alerting (Free)"]
        Al1[Discord Webhook<br/>DISCORD_WEBHOOK_URL]
        Al2[Slack Webhook<br/>SLACK_WEBHOOK_URL]
        Al3[Grafana Alerting<br/>Built-in, free tier]
    end

    Sources -->|JSONL / Logs| I1
    I1 --> St1
    St1 --> V1
    St3 --> V1
    V1 -->|Alert rules| Al1
    V1 -->|Alert rules| Al2
    V1 -->|Built-in alerts| Al3

    style Sources fill:#e3f2fd
    style Storage fill:#e8f5e9
    style Visualization fill:#f3e5f5
    style Alerting fill:#fff3e0
```

---

## 6. ตารางอ้างอิงไฟล์ ADR

| ADR | ไฟล์ | หัวข้อ | สถานะ |
|-----|-------|--------|--------|
| 0001 | `docs/adr/0001-cloudflare-durable-objects-bridge.md` | สถาปัตยกรรมหลัก v4.2.0: Worker + GeminiBridgeDO + MV3 Extension | ✅ สร้างแล้ว |
| 0002 | `docs/adr/0002-multi-session-load-balancing.md` | การกระจายโหลดหลาย Session (BridgeRouterDO) | ✅ สร้างแล้ว |
| 0003 | `docs/adr/0003-context-persistence-vector-memory.md` | Context Persistence: D1 + Vectorize | ✅ สร้างแล้ว |
| 0004 | `docs/adr/0004-session-health-auto-recovery.md` | Heartbeat & Auto-reconnect ของ Chrome Extension | ✅ สร้างแล้ว |

---

## 7. Third-Party & App Services Inventory (Free Tier เท่านั้น)

| หมวดหมู่ | บริการ | Tier | ใช้เพื่ออะไร | ที่ตั้ง |
|----------|--------|------|-------------|---------|
| Edge Runtime | Cloudflare Workers | Free | API Gateway, Durable Objects | `cloudflare-worker/` |
| Secrets | Doppler | Free | `prd_worker` config secrets | `~/.hermes/.env` |
| CI/CD | GitHub Actions | Free | Build, test, deploy | `.github/workflows/` |
| Monitoring | Grafana + Loki | Free (self-hosted) | Dashboards, alerting | `~/.hermes/monitoring/` |
| Database | SQLite WAL | Free | Telemetry, gate events | `~/.hermes/DIPS` |
| Notification | Discord / Slack Webhook | Free | HITL alerts, worker alerts | Doppler secret |
| Version Control | GitHub | Free | Repo, PR, Issues | `github.com/kimlenglim` |

---

*เอกสารนี้จัดเก็บใน Git ร่วมกับโค้ด ตามหลักการ **Read-Before-Modify** — AI Agent ต้องอ่านไฟล์นี้ก่อนแก้ไขสถาปัตยกรรมใดๆ ในระบบ*