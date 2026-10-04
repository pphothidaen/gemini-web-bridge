# Next steps — pick-up plan for an AI agent

> ## Status superseded — 2026-10-03
>
> The operational checklist below is historical and contains stale states.
> Read `docs/HANDOVER-2026-10-02.md` → **Continuation status — 2026-10-03** for
> current results: KAN-249 rotation verified, observability disabled, Jira
> `coding` backfill complete for 38 live matches, four fixtures restored, and a
> second-notebook capture taken. Latency data include a non-monotonic
> 0–69,924-character run and one visible-tab pair that rose from 3.49 to 4.68 s
> as rendered history increased from 0 to 10,672 characters. The pair had
> mismatched StreamGenerate request counts, so repeated pairs and a direct
> context-size measure are still needed. See the KAN-236 verification report.

Written 2026-10-02 at `0ffbe3f`. Production **4.7.31**, `CONNECTED_AND_READY`,
`consecutive_errors: 0`, suite **644 / 639 pass / 0 fail**. Payload capture is
**disarmed**.

Read this before acting. Several things below look like dead ends and are not,
and a few will produce a confident wrong answer if you do not know them first.

# Next steps — pick-up plan for an AI agent

> ## ⚠️ SUPERSEDED IN PART — read this first (2026-10-02, later)
>
> **Phase D is now COMPLETE.** All three captures were taken, both the
> chip-absent control and the stability pair, and the question Phase D existed to
> answer has an answer. Section 1 below is kept because its reasoning is still
> the clearest account of how that answer was reached, but it describes work that
> is done. Current remaining work is in "HANDOVER" below.

## HANDOVER — what is actually left

Production **4.7.33**, `CONNECTED_AND_READY`, `consecutive_errors: 0`, suite
**650 / 645 pass / 0 fail**. Repo synced with `origin/main`. `prompts/` is
tracked since KAN-204 and is now the source of truth the runtime stage prompts
are generated from (`scripts/sync-horo-prompts.mjs`). **Payload capture is
currently ARMED — disarm it before
handing over** (`POST /debug/payload-capture {"armed":false}`); an armed capture
is the exact risk the flag exists to prevent, and it is a live authenticated
endpoint.

### 1. Phase D result — the direct path is viable, with one dependency

Three captures, all self-reporting their producer build. The notebook binding is
at `[0][3][0][2]`: an 88-character token, `charset lower+upper+digit`,
fingerprint `cff9779e`, **stable across turns and across conversations** (the
conversationId fingerprints differ between the two stability turns, so the match
is not an artifact of one conversation).

It is not a UUID, not a URL, and not a `notebooks://` URI — which is exactly why
the classifier never flagged it and why an earlier round wrongly concluded the
binding was absent.

Consequence: a builder can emit the 20-field payload for a **known** notebook,
reusing the observed token. It cannot derive a token for an **unknown** notebook.
The practical shape is therefore: DOM path on first contact, direct path after.

Optional follow-ups, in order of value:
- **Close the `contains.notebook_id` gap.** It returned `null` on every capture,
  so the id-comparison question was never actually asked. Cause: the worker
  derives the id from `currentScope`, but attach-in-place keeps the scope at
  `app:*`, so the notebook id is not in the scope string. Use the notebook target
  scope instead. One-line change; the fingerprint evidence is already stronger.
- Then, and only then, `scripts/analyze-payload-shape.mjs` and
  `cloudflare-worker/tests/payload-shape-contract.test.mjs` — deliberately not
  written while the captures did not exist, because writing them pins a payload
  shape you cannot substantiate. They have a real consumer now.

### 2. KAN-249 — rotate the leaked GitHub PAT (human, ~2 min)

Unrotated. Scoped: **0** token-shaped strings in the working tree, **0** across
`git log -p --all`. CI uses `${{ github.token }}` plus `DOPPLER_SERVICE_TOKEN` /
`JIRA_CI_TOKEN` — **not** the PAT — so rotation needs no CI change and no
redeploy.

1. Mint a replacement: narrow `repo`, set an expiry.
2. **Revoke the old token.** This is the step that closes the exposure; step 1
   alone changes nothing.
3. Update `~/.config/gh/hosts.yml`.
4. Verify `gh auth status` and one `gh run list`.
5. Clear shell history — a rotation undone by a value in `~/.zsh_history` is not
   a rotation.

Never print the token. Do not run secret scanning in a way that surfaces matched
values into a transcript.

### 3. `coding` label — blocked on an MCP bug

Backfill target is the 37 tickets that are coding work:

```
project = KAN AND labels = "agent-developer_core"
```

**`atlassian__editJiraIssue` cannot set `labels`.** Every input shape the MCP
accepts is wrapped into `{"item": [...]}` and Jira rejects it with
`"Specify the value for labels in an array of strings"`. Nothing was mutated —
all attempts 400'd. Do not spend four tool calls rediscovering this.

Workaround: Jira UI → Issues → paste the JQL → select all → **Bulk Edit** →
Labels → Add `coding`. One operation, versus 37 individual edits that would
flood the activity stream.

Going forward add `coding` alongside `agent-developer_core` on new development
work. Deliberately not applied to KAN-249 (PAT rotation) — that is ops.

### 4. Gotchas that cost real time this session

- **Extension changes need a manual Reload** at `chrome://extensions`, in the
  **original** Chrome. Browser MCP is a different Chrome instance with zero
  extensions; Kapture cannot drive `chrome://` (NAVIGATION_BLOCKED) and
  `new_tab` ignores its URL entirely.
- **After every version bump, re-run `scripts/build-extension.py`.** Skipping it
  at 4.7.30 and 4.7.31 left `dist/extension` at 4.7.29 — the browser was loading
  a two-version-old extension and `dist/` is gitignored, so nothing noticed.
  `--verify` catches exactly this.
- **Navigation resets page-side capture state.** Arm AFTER navigating, not
  before. This was documented and then missed anyway.
- **`horo_consult` consumes the notebook attachment per message.** A second
  grounded turn in the same conversation fails `no_citations_in_response`. Start
  a fresh conversation for each capture.
- Kapture's console reader is detached (`totalCount: 0` where it once returned
  58); `/health` is public; a deploy does not reset the DO so `/health` can
  briefly report the previous version.

### 5. The pattern worth inheriting

Four blind instruments appeared in this work — a detached console reader, a relay
wired in one direction only, a classifier blind to `notebooks://`, and a capture
with no provenance. Every one produced an **absence**, in the same confident
register as a real result, and none announced itself. Each time the wrong
conclusion was available and would have been defensible.

The defences that actually worked: make the instrument self-identify
(`extensionVersion` on every capture), and ask what it would say if it were
working before believing an absence.

---

<details>
<summary>Original plan (Phase D — now complete; kept for the reasoning)</summary>

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
- `prompts/` was untracked early on; since KAN-204 it is tracked and is the
  source the worker's atomic stage prompts are generated from.

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

</details>
