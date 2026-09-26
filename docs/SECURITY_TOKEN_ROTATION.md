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

### Exposure was NOT history-only

An earlier revision of this runbook concluded the tokens were "removed in
`4f6cced`; exposure is git history only." **That was wrong.** Three further
exposures existed on the public default branch, and the most serious was not
in history at all — it was in the current tree:

| Vector | Where | Fixed |
|:--|:--|:--|
| **Committed build archive** | `gemini-bridge-v4.3.6.zip` at the **repo root**, tracked on `main`/`origin/main`, re-committed in `d903ebe` (Sep 25). Contained the live tokens in `settings.js`, `background.js`, `options.js`, `content.js` and `options.html`. One browser download from the repo front page — no git knowledge needed. | Untracked + deleted (`a526180`+), `*.zip` gitignored |
| **This runbook itself** | `docs/SECURITY_TOKEN_ROTATION.md:112-113` held both tokens **in plaintext at `HEAD`** (`a526180`), greppable by anyone with GitHub code search. | Redacted to `hermes-392e…d0e` / `gemini-bridge-5ee2…1240` |
| **Committed archive (clean)** | `extension-cloudflare.zip` was also tracked, but contained only `__BRIDGE_AUTH_TOKEN__` / `__CLIENT_API_TOKEN__` placeholders — a stray artifact, not an exposure. | Untracked |

Why it recurred twice: `release/` and `dist/` were gitignored but the archives
landed at the **repo root**, where nothing objected. The 16–17 `__MACOSX`
entries in each blob prove macOS Finder "Compress" rather than
`scripts/zip-extension.py` (which skips `__MACOSX`). Finder-zip → `git add` →
committed, with the existing guard test reporting 4/4 green: it only read
`extension-cloudflare/*.{js,html,json}`, so a compressed blob was invisible to
it, to gitleaks' default config, and to every text grep.

Rotation (not history rewriting) is the actual fix — a rewritten history is not
a guarantee, since GitHub caches dangling commits until Support purges them.
Removing the archives only shrinks the exposure; it does not invalidate the
credential.

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
# the tokens also appear in options.html and historical diffs; scrub by pattern.
# The exact values are redacted here on purpose — a literal token in this file is
# itself a leak (it happened at a526180). Read the exact values from the
# incident record / Doppler, then substitute them at run time:
#   git filter-repo --replace-text <(echo '<BRIDGE_AUTH_TOKEN>==>***REMOVED***')
#   git filter-repo --replace-text <(echo '<CLIENT_API_TOKEN>==>***REMOVED***')
# Known-leaked values were `hermes-392e…d0e` and `gemini-bridge-5ee2…1240`.
git push --force --mirror   # requires force-push rights; coordinate with collaborators
# then ask GitHub Support to purge dangling refs / cached views.
```

## 6. Repo-side hardening already applied (no operator action needed)

- `cloudflare-worker/tests/extension-secrets.test.mjs` — fails CI if any literal
  `hermes-*` / `gemini-bridge-*` value reappears **anywhere in the repo**
  (repo-wide `git ls-files` sweep, not just the extension dir), **inside any
  `.zip` archive** (members are inflated with `node:zlib` and scanned), if the
  extension defaults stop being `__BRIDGE_AUTH_TOKEN__` / `__CLIENT_API_TOKEN__`
  placeholders, or if a `wrangler*.toml` assigns a secret as a plain var.
- `cloudflare-worker/tests/extension-secrets.test.mjs` also asserts **no build
  artifacts are tracked** (`*.zip`, `*.tar*`, `dist/`, `release/`, …), so the
  Finder-zip class of leak cannot recur even if the sweep is bypassed.
- `.gitignore` — `*.zip` added, so root-level archives are ignored by default
  (`release/` and `dist/` were already ignored).
- `.githooks/pre-commit` — scans staged blobs for the same token patterns
  before every commit (`core.hooksPath=.githooks` is already configured).
- `.gitleaks.toml` — custom rules for the `hermes-` / `gemini-bridge-` prefixes,
  since gitleaks' default config knows nothing about them; wired into the
  `security-scan` job, which now also runs on pull requests.
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
