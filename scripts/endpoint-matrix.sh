#!/usr/bin/env bash
# Endpoint scenario matrix (KAN-175 follow-up). Reads keys from repo .env;
# never prints secret values, only status codes.
set -uo pipefail
cd "$(dirname "$0")/.."

KEY=$(python3 -c "
import re
env = open('.env').read()
m = re.search(r'^CLIENT_API_KEY=(.*)$', env, re.M)
print(m.group(1).strip().strip('\"') if m else '')
")
BR=$(python3 -c "
import re
env = open('.env').read()
m = re.search(r'^BRIDGE_AUTH_TOKEN=(.*)$', env, re.M)
print(m.group(1).strip().strip('\"') if m else '')
")
[ -n "$KEY" ] && echo "client key loaded (${#KEY} chars)" || { echo "NO CLIENT KEY"; exit 1; }
[ -n "$BR" ] && echo "bridge secret loaded (${#BR} chars)" || { echo "NO BRIDGE SECRET"; exit 1; }

BASE="https://prod.gemini-web-bridge.workers.dev"
t(){ printf '%-52s -> %s\n' "$1" "$2"; }

echo "=== round 2: current keys from .env ==="
t "GET /bridge/auth-check valid"    "$(curl -s -o /dev/null -w '%{http_code}' -H "x-bridge-token: $BR" "$BASE/bridge/auth-check")"
t "GET /v1/models valid key"        "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/v1/models")"
t "POST chat no messages"           "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"model":"x"}' "$BASE/v1/chat/completions")"
t "POST chat bad JSON"              "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d 'not-json' "$BASE/v1/chat/completions")"
t "GET /mcp valid key"              "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/mcp")"
t "GET /unknown valid key"          "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/does-not-exist")"
t "WS valid token + bad instanceId" "$(curl -s -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Version: 13' "$BASE/bridge?token=$BR&instanceId=not-a-uuid")"

echo "---models body (first 240 chars)---"
curl -s -H "Authorization: Bearer $KEY" "$BASE/v1/models" | head -c 240; echo
echo "---auth-check body---"
curl -s -H "x-bridge-token: $BR" "$BASE/bridge/auth-check"; echo
