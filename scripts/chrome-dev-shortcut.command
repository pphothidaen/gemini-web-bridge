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

# The gemini extension lives in THIS repo; the aipass one is a sibling
# checkout (override both via env when your layout differs).
GEMINI_EXT_DIR="${GEMINI_EXT_DIR:-$PROJECT_ROOT/extension-cloudflare}"
AIPASS_EXT_DIR="${AIPASS_EXT_DIR:-$HOME/Project/aipass-web-bridge/release/chrome-extension}"

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

# Chrome runs in foreground; Ctrl+C in terminal to quit.
