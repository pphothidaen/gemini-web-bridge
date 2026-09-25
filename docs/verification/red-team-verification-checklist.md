# 🔴 Red Team Verification Checklist — Phase 5

> **Purpose**: Pre-deployment adversarial validation of Phase 5 architecture. Each item must pass before Phase 4 → Phase 5 promotion gate.
> **Derived from**: Phase 5 Architecture Design handoff (Red Team analysis)
> **Owner**: Red Team + Blue Team (joint sign-off required)

---

## 1. Token Exposure

### RT-001: No hardcoded bridge tokens in extension source
- **Check**: No `gemini-bridge-[0-9a-f]{32}` pattern in any source file or build output
- **Method**: `grep -r 'gemini-bridge-[0-9a-f]' extension-cloudflare/ dist/extension/ && unzip -l extension-cloudflare.zip | grep -i token`
- **Pass criteria**: Zero matches in source; zero in built extension
- **Automated**: ✅ Yes
- **Status**: ⬜ Pending

### RT-002: Token not leaked via browser history / referer / devtools
- **Check**: Bridge auth token sent only via headers (`x-bridge-token`), never in URL query params or WebSocket URL
- **Method**: Inspect all `fetch()` and `WebSocket()` calls in content.js; verify token never appears in `window.location` or `document.referrer`
- **Pass criteria**: Token only in request headers; never in URL
- **Automated**: ❌ Manual review
- **Status**: ⬜ Pending

### RT-003: Error messages contain no sensitive data
- **Check**: Error responses do not include tokens, session IDs, internal paths, or user data
- **Method**: Grep all `STREAM_ERROR`, `failure()`, and `console.error` calls for variables that could contain secrets
- **Pass criteria**: All error messages are generic strings; no variable interpolation of sensitive data
- **Automated**: ✅ Yes
- **Status**: ⬜ Pending

---

## 2. Leader Stagnation

### RT-004: Standby auto-promotion within 15s
- **Check**: When leader tab crashes or stops sending HEARTBEAT, standby promotes within 15s
- **Method**: Set `isLeaderTab=true`, stop `startLeaderHeartbeat()`, verify `checkLeaderHealth()` fires after 15s (3 missed beats at 5s interval), promotes standby
- **Pass criteria**: New leader assigned within 15s ± 1s; `SESSION_READY` re-sent; no duplicate active connections
- **Automated**: ✅ Yes
- **Status**: ⬜ Pending

---

## 3. Protocol Fuzzing

### RT-005: Server rejects malformed messages
- **Check**: Server handles truncated JSON, oversized payloads, wrong types without crashing
- **Method**: Send malformed WebSocket frames of increasing severity: `{"type":`, 2MB payload, non-string type, null payload
- **Pass criteria**: Each returns structured error; server stays alive; no DoS vector
- **Automated**: ✅ Yes
- **Status**: ⬜ Pending

---

## 4. Scope Escape

### RT-006: Cross-scope data isolation
- **Check**: Prompts/responses from one scope (app) do not leak to another (notebook, horo_consult)
- **Method**: Connect two clients with different scopes; send execution on scope A; verify scope B tab does not receive the response
- **Pass criteria**: Scope isolation enforced; no cross-scope message delivery
- **Automated**: ✅ Yes
- **Status**: ⬜ Pending

---

## 5. Resource Exhaustion

### RT-007: Queue exhaustion returns 429
- **Check**: 11th concurrent request returns 429 when queue is full (maxQueue=10)
- **Method**: Send 12 concurrent POST requests; first queues, 10 fill queue, 11th+ returns 429
- **Pass criteria**: 11th+ requests return HTTP 429; first 10 stay in queue
- **Automated**: ✅ Yes
- **Status**: ⬜ Pending

---

## 6. Version Compatibility

### RT-008: Client v4.3.3 → Server v4.3.4 graceful degradation
- **Check**: Old client (protocolVersion 2) can connect to new server (supports 2–3)
- **Method**: Simulate `SESSION_READY` with `protocolVersion: 2` to server with range check (`>= 2 && <= 3`); verify 200 response, not 503
- **Pass criteria**: v2 client connects; server degrades to legacy mode; `auth-check` reports `minSupportedVersion: 2`
- **Automated**: ✅ Yes
- **Status**: ⬜ Pending

---

## 7. Crash Recovery

### RT-009: Service worker restart recovery
- **Check**: After SW restart, new instance connects without 409 conflict
- **Method**: Destroy socket, clear storage, re-init; verify `INSTANCE_ID` regenerated, new `SESSION_READY` accepted, old instance cleared via 45s stale timeout
- **Pass criteria**: No 409 on reconnect; new instance ID accepted; no orphaned connections
- **Automated**: ✅ Yes
- **Status**: ⬜ Pending

---

## 8. Error Response Content

### RT-010: Generic error responses
- **Check**: All error (400/401/503/429) responses use generic messages
- **Method**: Trigger each error condition; inspect JSON response body for tokens, model names, internal paths, stack traces
- **Pass criteria**: Only generic messages like `extension_upgrade_required`, `invalid_protocol_version`; no internal state exposed
- **Automated**: ✅ Yes
- **Status**: ⬜ Pending

---

## Sign-off

| Reviewer | Role | Date | Signature |
|----------|------|------|-----------|
| Red Team | Security probe | ⬜ | ⬜ |
| Blue Team | Robustness review | ⬜ | ⬜ |
| Orchestrator | Final approval | ⬜ | ⬜ |

> **Gate**: All 10 items must pass (✅) before Phase 4 → Phase 5 promotion. Any ❌ or ⬜ blocks promotion.
