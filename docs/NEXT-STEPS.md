# Next steps — pick-up plan for an AI agent

Written 2026-10-02 at `0ffbe3f`. Production **4.7.31**, `CONNECTED_AND_READY`,
`consecutive_errors: 0`, suite **644 / 639 pass / 0 fail**. Payload capture is
**disarmed**.

Read this before acting. Several things below look like dead ends and are not,
and a few will produce a confident wrong answer if you do not know them first.

## 0. Gates that will waste your time if you do not know them

| gate | why it matters |
|---|---|
| **Extension changes need a manual Reload** at `chrome://extensions`, in the **original** Chrome | Browser MCP is a *different* Chrome instance with zero extensions installed. Kapture cannot drive `chrome://` URLs (`NAVIGATION_BLOCKED`), and `new_tab` ignores its URL entirely and opens Kapture's own docs page. Nothing in either MCP can reload the extension. |
| **Kapture's console reader is detached** | `console_logs` returns `totalCount: 0` where it returned 58 at session start. It reports "nothing happened" when it has merely stopped working. Do not read an absence here as a finding. |
| **`/health` is public** | Unauthenticated `GET` returns 200. Never put conversation metadata there. |
| **A deploy does not reset the Durable Object** | `/health` can report the *previous* version for a while. Only the version string lags in recent releases, so this is cosmetic — but "the deploy failed" is the wrong conclusion. |
| **An extension reload resets page-side state** | `payloadCaptureArmed` lives in the page context. Re-arm after any navigation. |

## 1. Finish Phase D — the KAN-236 measurement (highest value)

The direct worker → `StreamGenerate` path is unbuilt. This decides whether it
can be. One of three captures exists; the other two do not.

**Do this first:** Reload the extension at `chrome://extensions` so
`injected.js` is **4.7.31**. This is required before anything below is
trustworthy — see §1.1.

Then, for each case:

```bash
KEY=$(doppler secrets get CLIENT_API_KEY --project gemini-web-bridge --config prd --plain | tr -d '\n\r')
BASE=https://prod.gemini-web-bridge.workers.dev/debug/payload-capture

arm()  { curl -s -X POST "$BASE" -H "Authorization: Bearer $KEY" \
           -H 'Content-Type: application/json' -d "{\"armed\":$1}"; }
read() { curl -s "$BASE?cb=$RANDOM" -H "Authorization: Bearer $KEY"; }
```

Arming **clears the buffer**, so cases cannot bleed into each other. Select the
StreamGenerate record — `hasEnvelope: true` is how you tell it from the other
BatchExecute RPCs, because **one turn emits several, most of which are
`outerLength: 1, hasEnvelope: false`**. There is no other StreamGenerate in the
buffer.
### 1.1 Re-take chip-present FIRST — and this is the one that matters

The 2026-10-02 chip-present capture is saved in
`cloudflare-worker/tests/fixtures/streamgenerate-captures.json`
(`app-chip-present-2026-10-02`). It showed **20 top-level fields** and
**zero `notebook_ref`** — which reads as "the notebook is not in the payload".

**Do not record that as a finding.** `classifyString` matched `notebook://` as a
prefix while the bridge's own scope is `notebooks://`, so every reference
classified `OPAQUE`. Fixed in 4.7.31 and pinned by a test — but the fix ships in
the extension. **Until the extension is confirmed reloaded on 4.7.31, that
capture was produced by the blind classifier.**

Re-take it after the reload. If `notebook_ref` appears, that is Phase D's real
answer. If it is still zero, *then* the negative is real and worth writing down
— and worth naming which strings were checked (7: lengths 484, 2, 0, 4, 88,
2305, 32).

### 1.2 chip-repeat

Run `horo_consult` a second time in the same conversation with the notebook
attached. This decides whether a notebook id is **stable across calls**, which is
what a direct path would have to cache. Compare against chip-present: any field
that changed is state, any that did not is constant.

### 1.3 chip-absent — the one that needs a human

`horo_consult` always attaches the notebook, so it cannot produce this case. A
human must send a plain message in a conversation with **no notebook chip**:

1. Reload the extension.
2. Open a **fresh** `/app` conversation (nothing attached).
3. `arm true`.
4. Send any message by hand.
5. `read` and save.

This is the discriminating case: the difference between chip-present and
chip-absent is what a direct path would have to reproduce to attach and untether
the notebook.

### 1.4 Write the verdict

Update `docs/NOTEBOOK-API-FEASIBILITY.md`. A negative / direct-path-closed
verdict is acceptable — an honest one is required. Only then consider
`scripts/analyze-payload-shape.mjs` and
`cloudflare-worker/tests/payload-shape-contract.test.mjs`; both were deliberately
**not** written while the captures did not exist, because writing them pins a
payload shape you cannot substantiate.

## 2. KAN-249 — rotate the leaked GitHub PAT (human, ~2 min)

Still unrotated. Scoped already: **0** token-shaped strings in the working tree,
**0** across `git log -p --all`, and CI uses `${{ github.token }}` plus
`DOPPLER_SERVICE_TOKEN` / `JIRA_CI_TOKEN` — **not** the PAT. So rotation needs
no CI change and no redeploy.

1. Mint a replacement — narrow `repo`, set an expiry.
2. **Revoke the old token.** This is the step that closes the exposure; step 1
   alone changes nothing.
3. Update `~/.config/gh/hosts.yml`.
4. Verify: `gh auth status` shows the new token, `gh run list` works.
5. Clear shell history — a rotation undone by a value still in `~/.zsh_history`
   is not a rotation.

Do not print the token anywhere. Do not run repo secret scanning in a way that
surfaces matched values into a transcript.

## 3. `coding` label — blocked on an MCP bug, not on a decision

The label does not exist yet; Jira creates it on first use. Backfill target is
the 37 tickets that are coding work:

```
project = KAN AND labels = "agent-developer_core"
```

**`atlassian__editJiraIssue` cannot set `labels`.** Every input shape is wrapped
into `{"item": [...]}` by the MCP server and Jira rejects it with
`"Specify the value for labels in an array of strings"`. Nothing was mutated —
all attempts 400'd before writing.

Workaround: Jira UI → Issues → paste the JQL → select all → **Bulk Edit** →
Labels → Add `coding`. One bulk operation, versus 37 individual edits that would
flood the activity stream.

Going forward, add `coding` alongside `agent-developer_core` on new development
work. Deliberately **not** applied to KAN-249 (PAT rotation) — that is ops, not
coding.

## 4. Not outstanding — do not redo these

- Phase C shipped and is **verified in both halves**: `collection.last_progress_at`
  on `/health` is non-null, which only a 4.7.25+ extension can produce.
- Phase E's `sendButtonFallback` **does** match (`gem-icon-button.send-button`);
  the earlier "zero match" was measured on an empty editor where no send control
  exists at all.
- `DISCONNECTED` immediately after a deploy is expected — reload the Gemini tab.
- The untracked `prompts/` directory is deliberate; leave it untracked.

## 5. House rules that will fail your commit otherwise

- Commit subject must start `KAN-<id>:` and the ticket must exist (the pre-push
  hook validates it against Jira). Do not invent an id.
- Release tags must match the worker version: `git tag -a v<version>` on the
  commit that declares it, or `extension-version-line.test.mjs` fails.
- Every version moves together: `package.json`, `package-lock.json`,
  `WORKER_VERSION`, `extension-cloudflare/manifest.json`. The manifest moves too
  whenever extension source changes.
- `cd cloudflare-worker && npm test` must be 0 fail before pushing.
- CD deploys on push to `main` and waits at the `production` environment gate.
  The approval call **requires** a `comment` field.


```bash
read | jq '.captures[].record
          | select(.structure.hasEnvelope)
          | {endpoint, fieldCount: (.structure.structure|length)}'
```
