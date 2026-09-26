# 🔐 Token Rotation Runbook — BRIDGE_AUTH_TOKEN / CLIENT_API_TOKEN

> **Status: OUTSTANDING — requires the operator.** The tokens below were exposed
> and, at the time of this audit, `CLIENT_API_TOKEN` was still accepted by the
> production worker. Rotating is a human/credentialed action; this document is
> the exact procedure. Everything that can be fixed in the repo already was
> (see "Repo-side hardening already applied").

## 1. What happened

| Token | Where it leaked | Still valid? (audited 2026-09-26) |
|:--|:--|:--|
| `BRIDGE_AUTH_TOKEN` (`gemini-bridge-…`) | Committed to `extension-cloudflare/{background,content,options}.js` + `options.html` in commit **`078824b`** ("pre-filled defaults"), removed in **`4f6cced`**. Both commits are ancestors of `main`/`origin/main` of the **public** repo `pphothidaen/gemini-web-bridge`. | Not probed (a WS connect could disturb the live extension session). Assume compromised. |
| `CLIENT_API_TOKEN` (`hermes-…`) | Same commits; also present in local (gitignored) `.env`, `cloudflare-worker/.env`, `release/gemini-bridge-v4.4.2/`. | **Yes — verified: `GET /v1/models` returned HTTP 200 with the leaked bearer token.** |
| `CLOUDFLARE_API_TOKEN` | Exposed in the deleted pre-migration repo `taijustarrett417-lgtm`. | Rotate. |

Anyone can still recover both tokens from history:

```bash
git log --all -S 'hermes-'
git show 078824b -- extension-cloudflare/settings.js
```

Rotation (not history rewriting) is the actual fix — a rewritten history is not
a guarantee, since GitHub caches dangling commits until Support purges them.

## 2. Rotate (do this first, in this order)

```bash
# 0. Authenticate to the PRODUCTION Cloudflare account (pansakorn-pho /
#    f1409612b13704c5a4be27820c9a41ae) — the deploy account and the host account
#    have been confused before, see IMPLEMENTATION_SUMMARY.md §1.
cd cloudflare-worker
npx wrangler whoami

# 1. Generate new values (keep the prefixes so logs/greps stay readable)
openssl rand -hex 24          # -> BRIDGE_AUTH_TOKEN
openssl rand -hex 24          # -> CLIENT_API_TOKEN

# 2. Push to the worker (secrets, NOT vars)
npx wrangler secret put BRIDGE_AUTH_TOKEN
npx wrangler secret put CLIENT_API_TOKEN
# staging, if used:
npx wrangler secret put BRIDGE_AUTH_TOKEN --env staging
npx wrangler secret put CLIENT_API_TOKEN  --env staging

# 3. Doppler (project: gemini-web-bridge, config: prd_worker) — the extension
#    build reads its tokens from here.
doppler secrets set BRIDGE_AUTH_TOKEN="…" --project gemini-web-bridge --config prd_worker
doppler secrets set CLIENT_API_TOKEN="…"  --project gemini-web-bridge --config prd_worker

# 4. Local env files (gitignored — update, never commit)
doppler secrets download --project gemini-web-bridge --config prd_worker \
  --format env --no-file > .env
# repeat for cloudflare-worker/.env

# 5. GitHub Actions secrets (deploy pipeline reads these)
gh secret set BRIDGE_AUTH_TOKEN; gh secret set CLIENT_API_TOKEN
# plus CLOUDFLARE_API_TOKEN if rotating that one
```

## 3. Re-point the extension and clients

```bash
# Rebuild the extension with the NEW tokens substituted into the placeholders
export DOPPLER_SERVICE_TOKEN=…        # or export BRIDGE_AUTH_TOKEN/CLIENT_API_TOKEN
python3 scripts/build-extension.py    # substitutes __BRIDGE_AUTH_TOKEN__ / __CLIENT_API_TOKEN__
python3 scripts/zip-extension.py      # release/gemini-bridge-v4.4.3.zip
```

Then, in Chrome:
1. Reload the unpacked extension (or install the new zip).
2. Open the extension options page and re-enter the new bridge token if the
   stored value is still the old one (stored in `chrome.storage`; the packaged
   default is only a placeholder).
3. Update every client config that used the old bearer token
   (`docs/client-configs.md`, IDE/plugin configs, `~/.hermes/config.yaml`).

## 4. Verify rotation

```bash
# old client token must now be rejected
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer <OLD_CLIENT_TOKEN>" \
  https://gemini-web-bridge.pansakorn-pho.workers.dev/v1/models      # expect 401

# new client token must work
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer <NEW_CLIENT_TOKEN>" \
  https://gemini-web-bridge.pansakorn-pho.workers.dev/v1/models      # expect 200

# old bridge token must be rejected on the WS upgrade
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Upgrade: websocket" -H "Connection: Upgrade" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "https://gemini-web-bridge.pansakorn-pho.workers.dev/bridge?token=<OLD_BRIDGE_TOKEN>&instanceId=<uuid-v4>"
# expect 401 (NOT 101)
```

Also confirm `/health` still reports the current release and a live extension:

```bash
curl -s https://gemini-web-bridge.pansakorn-pho.workers.dev/health | head -20
```

## 5. Optional: history purge (only AFTER rotation)

```bash
pip install git-filter-repo
git filter-repo --path-glob 'extension-cloudflare/*' --invert-paths   # not sufficient alone —
# the tokens also appear in options.html and historical diffs; scrub by pattern:
git filter-repo --replace-text <(echo 'hermes-392e28325564158e53712649fdc86d0e==>***REMOVED***')
git filter-repo --replace-text <(echo 'gemini-bridge-5ee24807fa35c8bca88ef89cc6401240==>***REMOVED***')
git push --force --mirror   # requires force-push rights; coordinate with collaborators
# then ask GitHub Support to purge dangling refs / cached views.
```

## 6. Repo-side hardening already applied (no operator action needed)

- `cloudflare-worker/tests/extension-secrets.test.mjs` — fails CI if any literal
  `hermes-*` / `gemini-bridge-*` value reappears, if the extension defaults stop
  being `__BRIDGE_AUTH_TOKEN__` / `__CLIENT_API_TOKEN__` placeholders, or if a
  `wrangler*.toml` assigns a secret as a plain var.
- `cloudflare-worker/wrangler.staging.toml` — the guessable
  `BRIDGE_AUTH_TOKEN = "staging-token-change-me"` plain var was removed; the
  worker now fails closed (401) until `wrangler secret put` is used.
- `release/` and `.env` remain gitignored (never committed).

## 7. Residual risk to be aware of

- `/bridge` authenticates with `?token=` **or** the `x-bridge-token` header
  (`src/index.js`). Browsers cannot set headers on a WebSocket handshake, so the
  extension must use the query parameter, which means the bridge token can land
  in Cloudflare request logs. Prefer the header for any non-browser client and
  treat edge logs as secret-bearing.
- `/health` and `/` are intentionally public (no auth) — they must never echo
  secrets. `red-team-adversarial.test.mjs` asserts this.
