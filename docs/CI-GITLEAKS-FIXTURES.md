# CI blocked: Gitleaks false positives on synthetic fixtures (KAN-236 left main red)

**Status:** `ci.yml` has been red since `2026-10-04 13:36` (run `37206241861`).
**Owner action needed:** amend `.gitleaks.toml` allowlist. No secret has leaked.
**Do not** disable the job, widen `useDefault`, or delete the scan.

## Symptom

`Security Scan (Secret Detection)` fails with 6 `generic-api-key` findings.
Every other job in the run is green — Lint, Build, Unit Tests, Jira comment,
Blueteam dependency audit all pass. Only the secret gate is red.

```
RuleID: generic-api-key  (all six)
```

| # | Location | What is actually there | Verdict |
|---|---|---|---|
| 1 | `cloudflare-worker/tests/kan182-telemetry-endpoint.test.mjs:202` | `AIzaSySecretApiKey1234567890` inside a string literal | **False positive** |
| 2 | `cloudflare-worker/src/streamgenerate-builder.js:27` | `KNOWN_HORO_88_TOKEN = "A1b2C3d4E5f6…"` | **False positive** |
| 3 | `cloudflare-worker/src/index.js:169` | `sanitizeForWinAnsi()` numeric glyph constants | **False positive** |
| 4 | `cloudflare-worker/tests/streamgenerate-builder.test.mjs:56` | `SAMPLE_88_TOKEN = 'A1b2C3d4E5f6…'` | **False positive** |
| 5 | `scripts/endpoint-matrix.sh:32` | `-H 'Sec-WebSocket-Key: …'` | **False positive** |
| 6 | `scripts/prod-endpoint-matrix.mjs:271` | `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==` | **False positive** |

## Why each is safe

**#1 — the fixture exists to prove redaction works.** The test asserts that
`recordTelemetry` scrubs `key=` out of error strings. It cannot pass without a
realistic-looking Google key to scrub:

```js
const longErrWithKey = 'GCP Gemini API error (400): ... ?key=AIzaSySecretApiKey1234567890 ...'
bridge.recordTelemetry({ kind: 'test', outcome: 'error', error: longErrWithKey });
```

The key is `AIzaSySecretApiKey1234567890` — the word `SecretApiKey` is spelled
out in the value. Real Google keys are `AIza` + 35 chars of `[A-Za-z0-9_-]`.

**#2 and #4 — sequential hex/alpha walk.** `A1b2C3d4E5f6G7h8I9j0…` increments by
one each character. No generator produces that by accident.

**#5 and #6 — RFC 6455 §1.3.** `dGhlIHNhbXBsZSBub25jZQ==` is base64 of
`the sample nonce`, the canonical example from the WebSocket protocol spec.
It is a fixed constant published in the RFC.

Note #6's value is **already** in the allowlist regexes — it just never applied,
because the allowlist's `paths` does not include `scripts/`. See below.

**#3 — no credential at all.** The reported line is `out += "?";` inside
`sanitizeForWinAnsi`, which replaces Thai glyphs with `?` so pdf-lib does not
crash. The surrounding lines are CP1252 codepoint constants.

## Root cause

`.gitleaks.toml` already has an allowlist titled *"Known non-secret constants and
build-time placeholders"*. Two gaps:

**Gap A — paths are too narrow.** The allowlist covers `cloudflare-worker/tests/`,
`docs/`, `.githooks/pre-commit`, `.gitleaks.toml`. Findings #2, #3, #5, #6 live
in `cloudflare-worker/src/` and `scripts/`, so no allowlist regex can reach them.

**Gap B — the synthetic fixtures are not listed.** `AIzaSySecretApiKey…` and
`A1b2C3d4E5f6…` are not in `regexes`, so #1 and #4 fail even though #1 sits under
a covered path.

## The fix

Extend `.gitleaks.toml`. Three edits, no workflow change.

```toml
  [[allowlists]]
  description = "Known non-secret constants and build-time placeholders"
  regexes = [
    '''__BRIDGE_SECRET__''',
    '''__CLIENT_API_KEY__''',
    '''<BRIDGE_SECRET>''',
    '''<CLIENT_API_KEY>''',
    '''<OLD_CLIENT_TOKEN>''',
    '''<NEW_CLIENT_TOKEN>''',
    '''<OLD_BRIDGE_TOKEN>''',
    '''staging-token-change-me''',
    '''dGhlIHNhbXBsZSBub25jZQ==''',
    # Synthetic fixtures. See docs/CI-GITLEAKS-FIXTURES.md — these are the
    # literal strings used to prove telemetry redaction and to stand in for an
    # 88-channel auth token. They are not credentials and never have been.
    '''AIzaSySecretApiKey\d{10}''',
    '''A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0''',
  ]
  paths = [
    '''cloudflare-worker/tests/''',
    '''cloudflare-worker/src/''',
    '''scripts/''',
    '''\.githooks/pre-commit$''',
    '''\.gitleaks\.toml$''',
    '''^docs/''',
  ]
```

The `AIzaSy…` regex anchors on the literal test prefix and requires digits after
it, so a real leaked `AIza` key cannot be waved through by this entry.

## Verify before pushing

```bash
docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest \
  detect --source /repo --config /repo/.gitleaks.toml -v
```

Expect zero findings. Then confirm the gate still bites — a real key must still
fail:

```bash
printf 'AIzaSyB7kQ2mZ9xR4tY6uI1oP3aS5dF0gH8jL2vN4\n' >> /tmp/x && \
  git add -A && git commit -m "tmp" && \
  docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest \
    detect --source /repo --config /repo/.gitleaks.toml -v; \
  git reset --hard HEAD~1
```

That synthetic key must be reported. If it is not, the allowlist is too broad.

## Regression test

`.gitleaks.toml` has already caused one silent failure here: `gitleaks-action@v2`
was passed `config:` as an input it does not declare, so the custom rules never
ran and the job reported green while scanning with defaults. That is recorded in
the comment above the `GITLEAKS_CONFIG` env var.

Consider a test asserting the allowlist still matches its six known strings —
otherwise the next person to widen `paths` can silently re-break this.

## Scope note

This failure is unrelated to the Cloudflare credential work. The Doppler
`CLOUDFLARE_*` secrets for `gemini-web-bridge` were removed at 13:25 UTC, and
`ci.yml` does not read Doppler — it uses `secrets.CLOUDFLARE_API_TOKEN`. The 12:22
run passed and the 13:36 run failed, with commit `1fa59c0` (KAN-236) landing in
between. Runs before `1fa59c0` were green.
---

## Second finding, not yet a CI failure: the scan scope is narrower than a full scan

While verifying the fix above, a local full scan surfaced **15 findings that CI
does not report**:

```
HANDOFF.md                       x7   rule=curl-auth-header
extension-cloudflare/background.js    rule=gemini-bridge-auth-token
extension-cloudflare/content.js   x2   rule=gemini-bridge-auth-token
extension-cloudflare/options.html      rule=gemini-bridge-auth-token
extension-cloudflare/options.js   x2   rule=gemini-bridge-auth-token
extension-cloudflare/settings.js  x2   rule=gemini-bridge-auth-token, hermes-client-api-token
```

These are all from historical commits — the oldest dated `2026-09-18`. **None of
the values are present in the working tree any more:**

```
$ grep -coE '(hermes|gemini-bridge)-[a-f0-9]{16,}' extension-cloudflare/settings.js
0
```

and `git log -S'hermes-'` shows them removed in `4f6cced`. So there is no live
leak. They matter for a different reason:

**CI's scan does not cover git history.** `gitleaks-action` reports the six
`generic-api-key` findings from the current diff and nothing older, while
`gitleaks detect --source .` walks the whole history and finds fifteen more. A
secret committed and later removed still sits in history, recoverable by anyone
who clones.

If those historical values were ever live, confirm they were rotated rather than
merely deleted. Deleting a file does not invalidate a credential.

Two options, in order of preference:

1. **Confirm rotation, then accept the history.** Cheapest, and honest. Record
   the rotation date against the `docs/SECURITY_TOKEN_ROTATION.md` entries.
2. **Scan history in CI too**, so this stops being a one-time observation:

   ```yaml
   - name: Run Gitleaks secret detection (full history)
     uses: gitleaks/gitleaks-action@v3
     env:
       GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
       GITLEAKS_CONFIG: ${{ github.workspace }}/.gitleaks.toml
   ```

   Note the action already defaults to a history scan; if the six findings are
   genuinely the whole set, the difference is which commits are reachable. Worth
   pinning `--log-opts` explicitly rather than relying on the default.

## Local reproduction

```bash
# full history, current config
gitleaks detect --source . --config .gitleaks.toml --redact \
  --report-format json --report-path /tmp/before.json

# with the proposed allowlist
gitleaks detect --source . --config /tmp/candidate-gitleaks.toml --redact \
  --report-format json --report-path /tmp/after.json
```

Measured on `1fa59c0`: **17 findings before, 15 after**, the two removed being
`cloudflare-worker/src/index.js:169` and
`cloudflare-worker/src/streamgenerate-builder.js:27`. Nothing new was introduced.

The four findings CI reports that this local scan does not reproduce
(`tests/`, `scripts/`) come from the action's own scan scope, so run CI to
confirm those clear rather than trusting the local count alone.
