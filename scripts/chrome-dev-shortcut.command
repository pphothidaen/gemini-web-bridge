#!/bin/bash
# =============================================================================
# Chrome Dev Shortcut — Load Extension + Remote Debugging
# =============================================================================
# Launches Google Chrome in unpacked-extension dev mode with remote debugging
# enabled, using an isolated user-data-dir so it never touches the user's
# main Chrome profile.
#
# Usage:
#   ./chrome-dev-shortcut.command              # load BOTH extensions
#   ./chrome-dev-shortcut.command gemini       # load gemini-web-bridge only
#   ./chrome-dev-shortcut.command aipass       # load aipass-web-bridge only
#   CHROME_PORT=9333 ./chrome-dev-shortcut.command gemini  # custom port
#
# After launch, open DevTools at:
#   http://localhost:$CHROME_PORT
# =============================================================================

set -euo pipefail

# ---- Configuration ---------------------------------------------------------

# Remote debugging port (override via env var CHROME_PORT)
CHROME_PORT="${CHROME_PORT:-9222}"

# Chrome binary (auto-detect)
CHROME_BIN="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

# Isolated user-data-dir for dev browsing (prevents profile contamination)
USER_DATA_DIR="${USER_DATA_DIR:-$HOME/Library/Application Support/Google/Chrome Dev Sessions/gemini-dev}"

# Extension directories
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# SCRIPT_DIR is <repo>/scripts, so the repo root is one level up; the aipass
# extension is a sibling checkout of that repo. PROJECT_ROOT above is the
# projects parent (two levels up) — both defaults stay env-overridable.
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GEMINI_EXT_DIR="${GEMINI_EXT_DIR:-$REPO_ROOT/extension-cloudflare}"
AIPASS_EXT_DIR="${AIPASS_EXT_DIR:-$REPO_ROOT/../aipass-web-bridge/release/chrome-extension}"

# ---- Resolve which extension(s) to load ------------------------------------

TARGET="${1:-both}"  # both | gemini | aipass

EXT_ARGS=()

case "$TARGET" in
    both)
        EXT_ARGS+=("--load-extension=$GEMINI_EXT_DIR,$AIPASS_EXT_DIR")
        ;;
    gemini)
        EXT_ARGS+=("--load-extension=$GEMINI_EXT_DIR")
        ;;
    aipass)
        EXT_ARGS+=("--load-extension=$AIPASS_EXT_DIR")
        ;;
    *)
        echo "❌ Unknown target: $TARGET"
        echo "   Usage: $0 [both|gemini|aipass]"
        exit 1
        ;;
esac

# ---- Validate paths --------------------------------------------------------

if [ ! -f "$CHROME_BIN" ]; then
    echo "❌ Google Chrome not found at: $CHROME_BIN"
    echo "   Set CHROME_BIN env var to your Chrome binary path."
    exit 1
fi

for ext_dir in "${EXT_ARGS[@]//--load-extension=/}"; do
    # Handle comma-separated paths
    IFS=',' read -ra PATHS <<< "$ext_dir"
    for p in "${PATHS[@]}"; do
        if [ ! -d "$p" ]; then
            echo "❌ Extension directory not found: $p"
            exit 1
        fi
        if [ ! -f "$p/manifest.json" ]; then
            echo "❌ No manifest.json in: $p"
            exit 1
        fi
    done
done

echo "🚀 Chrome Dev Shortcut"
echo "   Target: $TARGET"
echo "   Port:   $CHROME_PORT"
echo "   Profile: $USER_DATA_DIR"
echo "   Extensions: ${EXT_ARGS[*]#--load-extension=}"
echo ""

# ---- Launch Chrome ---------------------------------------------------------

# --no-first-run      Skip first-run UI
# --no-default-browser-check  Don't check default browser
# --disable-extensions except those loaded  We only want our unpacked extensions
# --user-data-dir      Isolated profile
"$CHROME_BIN" \
    --no-first-run \
    --no-default-browser-check \
    --disable-extensions-http-throttling \
    --remote-debugging-port="$CHROME_PORT" \
    --user-data-dir="$USER_DATA_DIR" \
    --disable-translate \
    --disable-background-timer-throttling \
    --disable-renderer-backgrounding \
    --disable-backgrounding-occluded-windows \
    --disable-ipc-foregrounding \
    "${EXT_ARGS[@]}"

# Run Chrome in the background so the script can verify its own success,
# then wait — Ctrl+C in the terminal still reaches Chrome's process group.
"$CHROME_BIN" \
    --no-first-run \
    --no-default-browser-check \
    --disable-extensions-http-throttling \
    --remote-debugging-port="$CHROME_PORT" \
    --user-data-dir="$USER_DATA_DIR" \
    --disable-translate \
    --disable-background-timer-throttling \
    --disable-renderer-backgrounding \
    --disable-backgrounding-occluded-windows \
    --disable-ipc-foregrounding \
    "${EXT_ARGS[@]}" &
CHROME_PID=$!

# ---- Post-launch verification ---------------------------------------------
#
# Chrome 137+ on branded builds SILENTLY IGNORES --load-extension. Everything
# above can succeed — Chrome launches, the debug port answers — while the
# extension was never loaded. Without this check the tool reports success and
# lies. The expected unpacked-extension ID is the SHA-256 of the resolved
# path, hex nibbles mapped to a-p (Chrome's unpacked-ID algorithm).
sleep 5
EXPECTED_ID=$(python3 - "$GEMINI_EXT_DIR" <<'PYEOF'
import hashlib, sys
path = sys.argv[1].rstrip("/")
print("".join(chr(ord("a") + int(c, 16)) for c in hashlib.sha256(path.encode()).hexdigest()[:32]))
PYEOF
)
if curl -s --max-time 5 "http://localhost:$CHROME_PORT/json/list" | grep -q "chrome-extension://$EXPECTED_ID/"; then
    echo "✅ Extension loaded — SW target chrome-extension://$EXPECTED_ID present"
else
    cat <<MSG
⚠️  VERIFICATION FAILED: the extension was NOT loaded (no target
    chrome-extension://$EXPECTED_ID). Chrome 137+ on branded builds ignores
    --load-extension entirely — this is a Google policy change, not a script
    bug. The debug port still works for page-level DevTools.
    Workarounds:
      1. Install Chrome for Testing and point CHROME_BIN at it (CfT still
         honours --load-extension):
         npx @puppeteer/browsers install chrome@stable
      2. Or load the unpacked extension by hand in this dev profile
         (chrome://extensions -> Developer mode -> Load unpacked), then
         re-run this script WITHOUT --load-extension to just attach.
MSG
fi

wait "$CHROME_PID"
