#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Gemini Web-Bridge — Health Check & Monitoring Script
# ═══════════════════════════════════════════════════════════════════════════
# Usage: bash scripts/health-check.sh [worker_url]
# 
# Performs comprehensive health checks on the deployed Cloudflare Worker:
#   1. Basic health endpoint
#   2. Auth verification
#   3. Model catalog availability
#   4. WebSocket connectivity
#   5. Response latency measurement
#   6. Error rate detection
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────

WORKER_URL="${1:-https://gemini-web-bridge.pphothidaen.workers.dev}"
CF_TOKEN="${CF_TOKEN:-}"
TIMEOUT=10
WARN_LATENCY_MS=2000
CRIT_LATENCY_MS=5000
RETRIES=3

# ─── Colors & Formatting ─────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color
BOLD='\033[1m'

PASS=0
FAIL=0
WARN=0

# ─── Helper Functions ─────────────────────────────────────────────────

log_info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
log_ok()    { echo -e "${GREEN}[PASS]${NC} $*"; ((PASS++)); }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; ((WARN++)); }
log_fail()  { echo -e "${RED}[FAIL]${NC} $*"; ((FAIL++)); }
log_section() { echo -e "\n${BOLD}═══ $* ═══${NC}"; }

check_jq() {
  if ! command -v jq &>/dev/null; then
    log_warn "jq not installed — JSON output will be raw"
    return 1
  fi
  return 0
}

# ─── Health Check Functions ──────────────────────────────────────────

check_basic_health() {
  log_section "Basic Health Check"
  
  local start end elapsed
  start=$(date +%s%N 2>/dev/null || echo $(date +%s)000000000)
  
  local response
  response=$(curl -s -w "\n%{http_code}" --max-time "$TIMEOUT" "${WORKER_URL}/health" 2>/dev/null)
  
  end=$(date +%s%N 2>/dev/null || echo $(date +%s)000000000)
  elapsed=$(( (end - start) / 1000000 ))
  
  local http_code
  http_code=$(echo "$response" | tail -1)
  local body
  body=$(echo "$response" | sed '$d')
  
  if [[ "$http_code" == "200" ]]; then
    log_ok "Health endpoint returned 200 OK (${elapsed}ms)"
    
    if check_jq; then
      local status
      status=$(echo "$body" | jq -r '.status // "unknown"')
      if [[ "$status" == "ok" ]]; then
        log_ok "Status field is 'ok'"
      else
        log_fail "Status field is '${status}', expected 'ok'"
      fi
    fi
    
    # Latency check
    if [[ $elapsed -gt $CRIT_LATENCY_MS ]]; then
      log_fail "Latency critical: ${elapsed}ms (threshold: ${CRIT_LATENCY_MS}ms)"
    elif [[ $elapsed -gt $WARN_LATENCY_MS ]]; then
      log_warn "Latency warning: ${elapsed}ms (threshold: ${WARN_LATENCY_MS}ms)"
    else
      log_ok "Latency acceptable: ${elapsed}ms"
    fi
  else
    log_fail "Health endpoint returned HTTP ${http_code} (expected 200)"
  fi
}

check_auth() {
  log_section "Authentication Check"
  
  if [[ -z "$CF_TOKEN" ]]; then
    log_warn "CF_TOKEN not set — skipping auth checks"
    return
  fi
  
  local response
  response=$(curl -s -w "\n%{http_code}" --max-time "$TIMEOUT" \
    -H "Authorization: Bearer ${CF_TOKEN}" \
    "${WORKER_URL}/bridge/auth-check" 2>/dev/null)
  
  local http_code
  http_code=$(echo "$response" | tail -1)
  local body
  body=$(echo "$response" | sed '$d')
  
  if [[ "$http_code" == "200" ]]; then
    log_ok "Auth check passed (HTTP 200)"
    
    if check_jq; then
      local ok
      ok=$(echo "$body" | jq -r '.ok // false')
      if [[ "$ok" == "true" ]]; then
        log_ok "Auth token is valid"
      else
        log_fail "Auth token validation failed"
      fi
    fi
  else
    log_fail "Auth check failed (HTTP ${http_code})"
  fi
}

check_models() {
  log_section "Model Catalog Check"
  
  local response
  response=$(curl -s -w "\n%{http_code}" --max-time "$TIMEOUT" \
    "${WORKER_URL}/bridge/models" 2>/dev/null)
  
  local http_code
  http_code=$(echo "$response" | tail -1)
  local body
  body=$(echo "$response" | sed '$d')
  
  if [[ "$http_code" == "200" ]]; then
    log_ok "Models endpoint returned 200 OK"
    
    if check_jq; then
      local count
      count=$(echo "$body" | jq '.models | length // (. | length)')
      if [[ "$count" -gt 0 ]]; then
        log_ok "Model catalog has ${count} models"
      else
        log_fail "Model catalog is empty"
      fi
    fi
  else
    log_fail "Models endpoint returned HTTP ${http_code}"
  fi
}

check_websocket() {
  log_section "WebSocket Connectivity Check"
  
  # Use Node.js for WebSocket check if available
  if command -v node &>/dev/null; then
    local ws_url="${WORKER_URL/https:/wss:}"
    local result
    result=$(node -e "
      const ws = new WebSocket('${ws_url}/bridge', ['gemini-bridge-v2']);
      const timeout = setTimeout(() => { ws.close(); process.exit(1); }, ${TIMEOUT}000);
      ws.onopen = () => {
        ws.send(JSON.stringify({type:'ping'}));
      };
      ws.onmessage = (e) => {
        clearTimeout(timeout);
        ws.close();
        process.exit(0);
      };
      ws.onerror = () => { clearTimeout(timeout); process.exit(1); };
    " 2>/dev/null)
    
    if [[ $? -eq 0 ]]; then
      log_ok "WebSocket connection established successfully"
    else
      log_fail "WebSocket connection failed"
    fi
  else
    log_warn "Node.js not available — skipping WebSocket check"
  fi
}

check_latency_distribution() {
  log_section "Latency Distribution (5 samples)"
  
  local total=0
  local min=999999
  local max=0
  local failures=0
  
  for i in {1..5}; do
    local start end elapsed
    start=$(date +%s%N 2>/dev/null || echo $(date +%s)000000000)
    
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
      "${WORKER_URL}/health" 2>/dev/null)
    
    end=$(date +%s%N 2>/dev/null || echo $(date +%s)000000000)
    elapsed=$(( (end - start) / 1000000 ))
    
    if [[ "$http_code" == "200" ]]; then
      total=$((total + elapsed))
      [[ $elapsed -lt $min ]] && min=$elapsed
      [[ $elapsed -gt $max ]] && max=$elapsed
      echo "  Sample $i: ${elapsed}ms"
    else
      ((failures++))
      echo "  Sample $i: FAILED (HTTP ${http_code})"
    fi
  done
  
  if [[ $failures -eq 0 ]]; then
    local avg=$((total / 5))
    log_ok "Average latency: ${avg}ms (min: ${min}ms, max: ${max}ms)"
  else
    log_fail "${failures}/5 requests failed"
  fi
}

check_worker_metadata() {
  log_section "Worker Metadata"
  
  log_info "Worker URL: ${WORKER_URL}"
  log_info "Timestamp: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  
  # Check if wrangler is available for additional info
  if command -v npx &>/dev/null; then
    local wrangler_info
    wrangler_info=$(cd cloudflare-worker 2>/dev/null && npx wrangler whoami 2>/dev/null || echo "unknown")
    log_info "Wrangler identity: ${wrangler_info}"
  fi
}

# ─── Main Execution ──────────────────────────────────────────────────

main() {
  echo -e "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}║  Gemini Web-Bridge — Health Check & Monitoring              ║${NC}"
  echo -e "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
  
  check_worker_metadata
  check_basic_health
  check_auth
  check_models
  check_websocket
  check_latency_distribution
  
  # ─── Summary ─────────────────────────────────────────────────────
  log_section "Summary"
  
  local total=$((PASS + FAIL + WARN))
  echo -e "  Total checks: ${total}"
  echo -e "  ${GREEN}Passed: ${PASS}${NC}"
  echo -e "  ${RED}Failed: ${FAIL}${NC}"
  echo -e "  ${YELLOW}Warnings: ${WARN}${NC}"
  
  if [[ $FAIL -gt 0 ]]; then
    echo -e "\n${RED}${BOLD}❌ Health check FAILED — ${FAIL} critical issue(s) detected${NC}"
    exit 1
  elif [[ $WARN -gt 0 ]]; then
    echo -e "\n${YELLOW}${BOLD}⚠️  Health check PASSED with warnings${NC}"
    exit 0
  else
    echo -e "\n${GREEN}${BOLD}✅ All health checks passed${NC}"
    exit 0
  fi
}

main "$@"
