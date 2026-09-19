#!/bin/bash
# setup-doppler-env.sh — Setup Doppler for gemini-web-bridge using service tokens
# Usage: source scripts/setup-doppler-env.sh

# ═══ Configuration (from HoroConsultant pattern) ═══
export DOPPLER_PROJECT="gemini-web-bridge"
export DOPPLER_CONFIG="prd_worker"
export DOPPLER_ENVIRONMENT="prd"

# ═══ Mask secrets in output ═══
export DOPPLER_MASK_SECRETS=***

# ═══ Verify Doppler access ═══
echo "🔍 Verifying Doppler access..."
if ! doppler secrets get BRIDGE_AUTH_TOKEN --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" --plain >/dev/null 2>&1; then
    echo "❌ Doppler authentication failed."
    echo ""
    echo "Fix options:"
    echo "1. Set DOPPLER_SERVICE_TOKEN in environment:"
    echo "   export DOPPLER_SERVICE_TOKEN=dp.st.xxxxx"
    echo ""
    echo "2. Or login via CLI:"
    echo "   doppler login"
    echo ""
    echo "3. Or rotate the leaked CLI token from ~/.doppler/.doppler.yaml"
    echo "   via Doppler Dashboard → Access → API Tokens"
    return 1 2>/dev/null || exit 1
fi

echo "✅ Doppler access verified for project: $DOPPLER_PROJECT"
echo ""

# ═══ Sync .env from Doppler ═══
echo "🔄 Syncing .env from Doppler..."
doppler secrets download \
    --project "$DOPPLER_PROJECT" \
    --config "$DOPPLER_CONFIG" \
    --format env \
    --no-file > .env

if [ $? -eq 0 ]; then
    echo "✅ .env synced successfully"
    echo ""
    echo "Synced secrets:"
    grep -E "^(BRIDGE_AUTH_TOKEN|CLIENT_API_TOKEN|WORKER_URL|MCP_ENDPOINT)=" .env | sed 's/=.*/=***/'
else
    echo "❌ Failed to sync .env"
    return 1 2>/dev/null || exit 1
fi
