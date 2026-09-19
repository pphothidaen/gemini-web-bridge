# Gemini Web-Bridge Chrome Extension

Chrome Extension MV3 that bridges an authenticated Gemini web session to the Cloudflare Worker.

## Quick Start

1. Build with secrets:
   ```bash
   python3 scripts/build-extension.py
   ```

2. Load unpacked in Chrome:
   - Go to `chrome://extensions`
   - Enable Developer mode
   - Click "Load unpacked" → select `dist/extension/`

3. Open extension options → enter `BRIDGE_AUTH_TOKEN` → click "Test Connection"

## Build System

Source files use placeholders:

```javascript
const DEFAULT_BRIDGE_SECRET = "__BRIDGE_AUTH_TOKEN__";
const DEFAULT_CLIENT_API_TOKEN = "__CLIENT_API_TOKEN__";
```

The `scripts/build-extension.py` script:

1. Fetches secrets from Doppler (`gemini-web-bridge/prd_worker`)
2. Copies source to `dist/extension/`
3. Replaces `__BRIDGE_AUTH_TOKEN__` → real `BRIDGE_AUTH_TOKEN`
4. Replaces `__CLIENT_API_TOKEN__` → real `CLIENT_API_TOKEN`
5. Adds `.gitignore` to prevent accidental commit of built files

## Environment Variables

Secret is sourced from:

1. Doppler CLI (`doppler secrets get BRIDGE_AUTH_TOKEN ...`)
2. Environment variable `BRIDGE_AUTH_TOKEN`

Same for `CLIENT_API_TOKEN`.

## File Structure

```
extension-cloudflare/          Source (placeholders, no secrets)
  background.js                Service worker
  content.js                   Content script (isolated world)
  options.html                 Settings UI
  options.js                   Settings logic
  settings.js                  Shared defaults (placeholders)
  manifest.json                Extension manifest

dist/extension/                Build output (secrets injected)
                               .gitignore prevents commit
```

## Security

- Source files contain NO real secrets — only placeholders
- `dist/extension/` is gitignored
- Never commit built files
- Rotate tokens via Doppler → redeploy worker → rebuild extension
