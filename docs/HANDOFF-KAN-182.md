# KAN-182 Session Handoff — typing fallback, and the grounding bug it exposed

> **Date:** 2026-09-29 · **Branch:** `main` · **Base commit:** `2c3dd94` (KAN-177, clean)
> **Production:** `https://prod.gemini-web-bridge.workers.dev` · **v4.7.9** · worker `75249e36` deployed
> **Tests:** 409 passing, 0 failing (was 384; +25 across the grounding, stale-answer, typing and attribution fixes)
> **Working tree:** uncommitted by request (see §1, §9)
> **Jira:** `KAN-182` (Relates to KAN-177)

Read this before touching the code. Two findings below were only visible by
looking at a live browser, and both contradict what the source implies.

> **The grounding bug in §6 is fixed and unit-tested.** The extension still
> needs a manual reload (§5) before the live end-to-end run.

---

## 1. State: what is committed, what is not

**Committed and live:** `KAN-177` / `2c3dd94`

| File | Change |
|---|---|
| `extension-cloudflare/notebook-attach.js` | NEW — drives `+ > more uploads > Notebooks > Horo` |
| `extension-cloudflare/native-recovery.js` | `generatingSignal()` no longer reads the sidenav spinner as "generating" |
| `extension-cloudflare/{content,background,manifest,protocol-messages}.js` | `ATTACH_NOTEBOOK` wiring |
| `cloudflare-worker/src/index.js` | `runNotebookAttach()`, `notebookGrounding`, `check_bridge_health.notebook` |

**Uncommitted (KAN-182):**

```
 M cloudflare-worker/src/index.js          typePromptThroughUi(), collectTypedAnswer(), replay fallback,
                                           verifyNotebookGrounding(), verified/-32000, health grounding fields
 M cloudflare-worker/tests/gemini-refusal-retry.test.mjs   7 grounding tests (replaced the idempotency test)
 M cloudflare-worker/tests/mcp-protocol.test.mjs          3 new + 6 grounding stubs
 M cloudflare-worker/tests/sdlc-tool-args.test.mjs         1 grounding stub
 M cloudflare-worker/tests/red-team-adversarial.test.mjs  1 grounding stub
 M extension-cloudflare/background.js      routes GROUNDING_RESULT
 M extension-cloudflare/content.js         handleTypePrompt(), handleCollectAnswer(), handleVerifyGrounding()
 M extension-cloudflare/manifest.json      + prompt-typing.js
 M extension-cloudflare/notebook-attach.js no alreadyAttached; + readGroundingEvidence()
 M extension-cloudflare/protocol-messages.js  TYPE_PROMPT / COLLECT_ANSWER / VERIFY_GROUNDING
 M docs/HANDOFF-KAN-182.md                 this file
?? extension-cloudflare/prompt-typing.js   NEW
```

The worker is deployed and the extension is built to
`dist/extension` (v4.7.0). **The extension is not reloaded yet** — see §5.

> Every test that stubs a *successful* `runNotebookAttach` also needs a
> `verifyNotebookGrounding` stub, or the new check waits out its 20s timeout and
> the test fails as if grounding were broken. 6 sites needed it.

---

## 2. The defect being fixed

`horo_consult` and every other browser-backed tool time out after 60s with
**0 `user-query` and 0 `model-response` rendered**. The question never leaves
the browser.

Cause: the bridge POSTs an assembled `StreamGenerate` payload
(`injected.js:312-327`, `f_req` from `model-adapter.js:134`) and Google has
changed that schema, so it is rejected for everything — including
"What is the capital of France?".

**Do not re-investigate these** (falsified, carried from KAN-176):

| Hypothesis | Falsified by |
|---|---|
| Prompt is too robotic | Same failure for plain prose and for "capital of France?" |
| `[Role:]` → `Act as` | Byte-identical failure, tested live |
| Code fence breaks it | Same fence via `/v1/chat/completions` answers correctly |
| Notebook attachment is at fault | Ruled out 2026-09-29: the notebook attached successfully and the call *still* timed out |

## 3. Why the fix is the DOM, not the payload

A captured native request (2026-09-29, live tab, Kapture network monitor):

```
POST /_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate
  ?bl=boq_gemini-web-uiserver_20260928.01_p0&f.sid=…&hl=th&_reqid=…&rt=c
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
X-Same-Domain: 1
f.req=[null,"<json string>"]&at=<CSRF>
```

The **outer shape matches what the bridge already builds**. What differs is
inside: Gemini's inner array is ~40 elements and carries `c_<conversationId>`,
an `r_…` session id, a large context blob, and — critically —
`notebook://notebooks/<id>/sources/<uuid>` entries. The bridge sends
`[["prompt"]]`.

So rebuilding `f_req` is **not** a schema tweak; it needs correct conversation
state, and `r_…` is still unaccounted for. That is why the DOM path is the
right mitigation now, and why the real fix is separate work.

**The DOM path also repairs the primary path.** `injected.js:329-330` marks the
bridge's own calls in `internalBridgeCalls` so the interceptor ignores them —
deliberately, so a broken schema cannot verify itself. A page-initiated request
is therefore recorded as real evidence. Every fallback teaches the registry what
a current request looks like.

---

## 4. How to fill a rich-text editor (the expensive part of this session)

Three approaches were tested on a live tab. **Each fails differently, and each
looks like success at first glance.**

| Approach | Text | Send button | Verdict |
|---|---|---|---|
| `editor.textContent = t` + `InputEvent` | **lands TWICE** — Quill reconciles its own model against a DOM that already holds a copy | — | unusable |
| `quill.setText(t, 'api')` | correct | **never appears** — Angular never learns the editor has content | unusable |
| **`quill.setText(t, 'user')`** | correct | **appears** — `'user'` makes Quill emit keystroke-equivalent events | **use this** |

Reached via the `__quill` property Angular leaves on `rich-textarea`:

```js
const host = document.querySelector("input-area-v2 rich-textarea");
host.__quill.setText(text, "user");            // NOT "api", NOT textContent
host.__quill.setSelection(host.__quill.getLength(), host.__quill.getLength(), "silent");
```

This needs **no `chrome.debugger` permission** — no synthetic key events are
dispatched. That was a deliberate choice; do not add the permission.

Send button: `input-area-v2 button:has(mat-icon[data-mat-icon-name="arrow_upward"])`
— never its `aria-label`, which is `ส่งข้อความ` in Thai.

### The hidden-tab trap, twice

A CDK overlay pane is created and the trigger flips to `aria-expanded="true"`
even on a **hidden** tab, but Angular never populates the panel. Every child
selector then matches nothing and the flow fails several steps later, which
reads as a broken selector. Both `prompt-typing.js` and `notebook-attach.js`
call `isTabVisible()` first and return a distinct `tab_not_visible`.

> The bridge must focus the tab, or the caller gets an honest error rather than
> a silent no-op. Auto-focusing the tab is a possible follow-up; it is not done.

## 5. To resume: reload the extension first

`prompt-typing.js` is new and the manifest now lists it, but the extension has
not been reloaded since. **Evidence it is still the old build:** reloading the
Gemini tab produces *no* `[Bridge] 🚀 Content Script Initialized` log at all.

```bash
cd /Users/kimlenglim/Project/gemini-web-bridge
set -a; source .env; set +a
python3 scripts/build-extension.py          # already run; re-run if src changed
# then chrome://extensions → "Gemini Web-Bridge Cloudflare" → 🔄
```

Keep the Gemini tab **in the foreground** for the live test.

**Note:** the live conversation now holds 7 `model-response` elements. The
grounding check only reads the newest, so a leftover conversation still works
correctly — but expect `verified: false` if you ask again without re-attaching,
which is the intended behaviour and the whole point of the fix.

Then:

```bash
cd cloudflare-worker && npm test                       # expect 392
node scripts/ask-each-skill.mjs --tools=horo_consult    # the first real answer
node scripts/ask-each-skill.mjs --tools=horo_consult    # the second — must also be grounded
node scripts/native-recovery-smoke.mjs
```

Both calls must return `notebookGrounding.verified === true`. If the second one
errors with `no_citations_in_response`, the live fix is not working.

## 6. OPEN, and approved: the notebook grounding bug

> **STATUS 2026-09-29: FIXED and unit-tested (392/392). Live test still pending.**
> The code below is what was approved; it has now been implemented. What
> remains is §5 (reload the extension) and two real `horo_consult` calls.

**This was the most important thing in the handoff.** The notebook does not stay
attached across calls, which materially affects answer quality.

Measured by capturing real `f.req` payloads:

| Sequence | `notebook://…/sources/…` in payload |
|---|---|
| attach → send | **present** |
| send again, no attach | **absent** |
| attach again → send | **present, exactly one set** |

> **Grounding is per-message, not per-conversation.** The chip in the input area
> is what *will* be applied to the next message, not a record of grounding that
> is active. The chip disappears once the message is sent, and Gemini's own
> attach dialog reports the notebook as `aria-selected="false"` on reopen.

Re-attaching does **not** stack — the third row above is one set, not two. The
user was right to ask; the answer is "no stacking, but also no persistence".

### The bug this creates

`notebook-attach.js` skips the attach when a chip is present:

```js
if (isNotebookAttached(name, doc)) {
  return { ok: true, alreadyAttached: true };   // WRONG
}
```

So from the **second** `horo_consult` call onward the answer is ungrounded while
still being reported as `attached: true`. That is worse than having no
reporting, because the caller cannot tell the difference.

Worse, the check is unreliable in the other direction too: stale
`source-inline-chip` elements persist in the DOM from earlier responses, so a
grounded-looking response can appear when the payload carried no notebook refs at
all. **DOM chips are not evidence of grounding.**

### Approved fix (do this next)

1. **Attach on every call.** Remove the `alreadyAttached` skip.
2. **Verify grounding from the response, not the DOM.** Check
   `source-inline-chip` inside the **newest** `model-response` and look for
   `[cite:` in its text.
3. **Report `attached` and `verified` separately**, e.g.
   ```json
   "notebookGrounding": {
     "requested": "Horo", "attached": true,
     "verified": false, "reason": "no_citations_in_response"
   }
   ```
4. **Fail loudly when `verified` is false** — same treatment as a failed
   attach. `horo_consult` must not return an ungrounded BaZi answer that looks
   grounded; the caller cannot detect that from the text.
5. **Add tests** pinning that a stale chip from an earlier response does not
   count, and that a missing chip is a hard error.

### As implemented

| Change | File |
|---|---|
| stale chip removed + full flow always runs | `notebook-attach.js` |
| `readGroundingEvidence()` — newest response only | `notebook-attach.js` |
| `VERIFY_GROUNDING` / `GROUNDING_RESULT` | `protocol-messages.js` |
| `handleVerifyGrounding()` | `content.js` |
| route the new result | `background.js` |
| `verifyNotebookGrounding()` | `src/index.js` |
| `verified` decided after the answer; `-32000` when unverified | `src/index.js` |
| `last_grounding_status` in health | `src/index.js` |
| 7 new tests | `gemini-refusal-retry.test.mjs` |
| 3 new tests + 6 grounding stubs | `mcp-protocol.test.mjs` |

**Stale-chip trap proven against the live DOM** (not inferred). The conversation
holds 7 `model-response` elements. The two `source-inline-chip` elements belong
to `#kapture-4` — the **5th of 7**. The newest two responses contain **zero**
chips. A document-wide scan would have reported those two as grounded.

```
(//model-response)[last()]//source-inline-chip  →  []      (ungrounded)
document-wide source-inline-chip                →  2 chips (stale, 3 turns back)
```

Note `[last()]` in XPath means "last child of parent", not "last in document" —
the code uses JS `responses[responses.length - 1]`, which is the correct one.
Both forms were checked so the difference is not mistaken for a result.

## 7. Environment notes that cost real time

- **Watch Gemini with Kapture, not chrome-devtools.** chrome-devtools runs an
  automation-flagged Chrome that Google refuses to sign into.
- Kapture cannot reach `chrome://extensions`; a `new_tab` there silently opens
  a docs page instead. The user must click Reload.
- `kapture__show` is unreliable — `pageVisibility` can stay `hidden`. Check
  `document.visibilityState` inside the page before trusting a UI-driven flow.
- The page's `fetch` and `XMLHttpRequest` are wrapped by the extension, so
  loading a module over `http://127.0.0.1` from page context fails. Test
  module logic by inlining the real source into `kapture__evaluate`, or verify
  in Node and against the live DOM separately.
- Content scripts run in the **ISOLATED** world: `globalThis.NotebookAttach`
  is not visible from a page-context evaluate. Absence there proves nothing.
- Secrets live in `.env` (`CLIENT_API_KEY`). Never print them.

## 8. Conventions

- **A version bump is mandatory for any change or update** (standing rule, set
  2026-09-29). Four files move together, and
  `tests/version-consistency.test.mjs` fails the build if they drift:
  `WORKER_VERSION` in `src/index.js` (plus its informational `// Version:`
  comment), `package.json`, `package-lock.json` (**both** `version` and
  `packages[""].version` — the test asserts both), and
  `extension-cloudflare/manifest.json`. Add a CHANGELOG entry too.
  This release is 4.7.0 → **4.7.1** (patch: a correctness fix, not a new
  capability).
- `python3 scripts/build-extension.py` syncs the built manifest to the source
  manifest but does NOT touch the worker/package versions, so the three worker
  files are always manual.
- Test harnesses load `index.js` via `vm.runInNewContext` with an explicit
  context. **Any new module imported by `src/index.js` must be added to every
  harness** (`tests/helpers/mock-worker.mjs`, `bridge-handshake`,
  `multiplexed-protocol`, `scope-switch-roundtrip`, `tool-loop`,
  `mcp-protocol`, `sdlc-tool-args`, `health-metrics`, `red-team-adversarial`).
  The failure is `ReferenceError: <name> is not defined`, not an import error.
- A test that stubs a successful `runNotebookAttach` must also stub
  `verifyNotebookGrounding`. Without it the new check waits out a 20s timeout
  and the test fails as though grounding were broken — which reads like a
  performance bug rather than a missing stub.
- Commits must cite a real Jira ticket or `.githooks/commit-msg` rejects them.
- Selector rules learned the hard way: never match a localized label, never
  match a list position, prefer `data-test-id` / class / icon name, and **verify
  every selector by driving the real UI and re-reading the DOM** — a selector
  read from a DOM sample is a hypothesis. The `__lottie_element` selector from
  KAN-176 was "verified" that way and matched nothing in production, so every
  wait silently degraded. `generatingSignal()` was found matching the sidenav's
  permanent chat-history loader, which made a wait that could never resolve
  look like an upstream outage.

## 9. Commit discipline

KAN-182 stays **uncommitted** until the two consecutive live `horo_consult`
calls pass (see §5, §6). Do not commit a fallback whose real path has never run
end to end through MCP. Deferred as separate follow-up work: the HTTP replay
path and `r_…` session-token research (KAN-182).

## 10. LIVE RUN LOG — 2026-09-29

### What the live run proved (4.7.1, worker `d2fad12b`)

`horo_consult` returned:

```
-32000 horo_consult attached the "Horo" notebook, but the answer came back
with no citations from it (reason=no_citations_in_response).
```

This is the **new** error text, and the reason is `no_citations_in_response`
rather than `grounding_check_timeout` — the extension answered
`VERIFY_GROUNDING` at all, so the reloaded build is live. Health agreed:

```
last_attach_status    = ok
last_grounding_status = ungrounded
last_grounding_reason = no_citations_in_response
```

So the grounding check works, and it caught a real fault that had been silent
before. KAN-182 is doing its job.

### A second, older bug it uncovered (fixed in 4.7.2, worker `3b4e1055`)

The prompt **never landed**. Live DOM at the time:

| Signal | Value | Meaning |
|---|---|---|
| `user-query` count | 8 (unchanged) | nothing was asked |
| `input-area-v2 .ql-editor` | `<p><br></p>`, class `ql-blank` | editor empty |
| `input-area-v2 uploader-file-preview` | present | chip attached, never consumed |
| newest `model-response` | the **test-C** answer from the previous turn | stale |

`waitForResponseChange()` resolved `{changed:false, text:<that stale text>}` on
timeout and `executeThroughExtension` took it unconditionally
(`text = collected.text`, `ok` ignored). The tool therefore answered with the
previous turn's text and then failed grounding **on it** — reporting a notebook
fault when the real fault was that no question was asked. Fixed both halves: a
timeout now returns `""`, and an unreadable answer raises its own error.

### The remaining blocker: `getQuill()` probably finds nothing

`rich-textarea` serialises as:

```html
<rich-textarea class="text-input-field_textarea ql-container ql-bubble …">
  <div class="ql-editor ql-blank textarea new-input-ui" contenteditable="true">…</div>
```

`getQuill()` looks for a **`__quill` JS property** on that host. The DOM shows
the `ql-container` class but a serialised DOM cannot show JS properties, so
this is *not yet proven* — it is the leading hypothesis for why the editor stays
blank, and it fits: `setPromptText` falls through to the `textContent` path,
which Angular then reconciles back to empty.

**To confirm, drive it in the page** (`kapture__evaluate` returned `{}` for
every call in this session and is unusable — use `compose` with
`elements`/`dom`, or check `host.__quill` from the content-script console):

```js
const host = document.querySelector('input-area-v2 rich-textarea');
host.__quill                                  // what prompt-typing.js assumes
Object.keys(host)                             // any *Quill* key at all?
host.querySelector('.ql-editor').__quill      // or on the editor itself
```

If none exist, reach the instance through whatever Angular actually exposes, or
set the text and dispatch the events Angular listens for. **Do not** fall back
to `textContent` alone — that path is already known to double the text when it
does work.

### SOLVED — the editor works; our write path did not (4.7.3, worker `ea4f378e`)

`getQuill()` was the wrong lead. Driving **real input events** through Kapture's
`compose` proved the editor is fine:

| probe | result |
|---|---|
| `insertText` "PROBE-TEST-123" | `<p>PROBE-TEST-123</p>`, `ql-blank` gone ✅ |
| `clear` | back to `<p><br></p>` + `ql-blank` ✅ |
| `insertText` Thai | text landed ✅ |
| send button present? | **yes** — `input-area-v2 button:has(mat-icon[data-mat-icon-name="arrow_upward"])` ✅ |
| click send | a **9th** `user-query` appeared (`kapture-13`) ✅ |

So the whole path works with genuine input events; only the synthetic ones
failed. `setPromptText()` is reworked accordingly:

1. Quill if `getQuill()` finds one (now also checks the inner `.ql-editor`);
2. otherwise `focus()` + `execCommand('insertText', false, value)`, which emits
   the real `beforeinput`/`input` pair Quill's own listeners react to;
3. `textContent` only as a last resort, with the mandatory read-back catching
   the known doubling.

No `chrome.debugger` permission, and `textContent` is still never primary.

> A caveat on the probe: CDP `insertText` dropped some Thai characters
> ("ทดสอบข้องคำวี" for "ทดสอบข้อความ"). That is Kapture's encoding on the
> probe path, not the extension's — `execCommand` passes the string through
> untouched. Worth re-checking on the real run rather than assuming.

### LIVE RUN 2 (4.7.3) — still not through, and the gap is now narrow

`horo_consult` again returned `no_citations_in_response`. DOM after the run:

| Signal | Value | Reading |
|---|---|---|
| `user-query` | **8, unchanged** | the prompt still did not land |
| newest `user-query` text | "ทสอบข้องคำวี" | my *manual* probe, not a 4.7.3 prompt |
| `.ql-editor` | `<p><br></p>` + `ql-blank` | empty again |
| `uploader-file-preview` | **new** element each run | attach still works every time |
| `last_error` | `notebook_grounding_unverified:…` | no `collect_answer_failed` |

That last row matters: there is **no** `collect_answer_failed`, so
`collectTypedAnswer` reported success while the `user-query` count never
moved. The 4.7.2 guard covers a *timeout*; it does not cover "a response from
an earlier turn is still on the page and looks new enough". **That is the next
gap to close, and it is not closed yet** — see the action list at the end.

### What is now proven about the editor

Driven directly, with the Horo chip present throughout:

| probe | result |
|---|---|
| `insertText` "EXEC-PROBE-1" | `<p>EXEC-PROBE-1</p>`, `ql-blank` cleared ✅ |
| `clear` | back to `ql-blank` ✅ |
| ASCII vs Thai | ASCII byte-exact; **Thai loses characters** |

So the chip is *not* what stops the write, and the editor is *not* broken.
`execCommand('insertText')` from the content script still does not stick,
while CDP input does — that difference is the open question.

> The Thai truncation is now confirmed as a **CDP `insertText` artefact, not an
> app bug**: Gemini itself replied *"ข้อความพิมพ์ผิดเล็กน้อยจากคำว่า
> "ทดสอบข้อความ""* — it saw the correct string. The 4.7.3 changelog flagged
> this as needing re-checking; this answers it. `execCommand` passes the
> string through untouched and is unaffected.

### The next live step

Reload the extension (4.7.3 changed `prompt-typing.js`), then run
`horo_consult` twice. Expect, in order:

- **run 1** — `verified: true`, and a **10th** `user-query` in the DOM.
- **run 2** — the same. That is the pair the whole ticket exists for.

If run 1 reports `no_citations_in_response` again while a new `user-query`
*did* appear, the typing fix landed and the remaining question is Gemini's
citation behaviour rather than the bridge's.

### Also worth knowing

- `kapture__evaluate` returned `"value": {}` for **every** invocation in this
  session, including a trivial `document.querySelectorAll(...).length`. Treat it
  as broken here; use `compose` with `elements` / `dom` / `console_logs`.
- `console_logs` returned an empty array even after a full reload, and
  `watch_console` for 20s also returned nothing — so **Kapture cannot see this
  extension's content-script logs at all**. That is why "no `[Bridge] 🚀` log"
  was NOT usable as evidence of a stale build. The behavioural check (does the
  extension answer `VERIFY_GROUNDING`?) is the only reliable signal, and it is
  the one to use again.
- The re-attach path is confirmed working: a second `horo_consult` produced a
  *new* chip element (`kapture-9` → `kapture-10`), i.e. the old
  `alreadyAttached` short-circuit really is gone.
### Action 1 — CLOSED in 4.7.4 (worker `590ed131`)

`waitForResponseChange()` now takes an options object and a `minResponses`
floor; a response at or below the snapshot count can never satisfy it.
`handleCollectAnswer` snapshots the count before waiting and re-checks it after
the streaming settle, then reports `no_new_response_rendered` plus the observed
count. `retryViaUi` passes `minResponses: 0` — regenerate re-renders in place
rather than appending, so a floor would break it.

`countModelResponses()` is exported and returns 0 rather than throwing when the
document cannot be queried.

4 new tests: an older response is rejected even when its text differs;
`countModelResponses` counts and survives a throwing document; a newly appended
response is accepted; the default `minResponses: 0` keeps regenerate working.

**This is why the live run said `no_citations_in_response`** — the grounding
check was grading a response the caller never asked for. On 4.7.4 the same
situation reports `no_new_response_rendered` with the count, which points at the
real fault.

### Action 2 — CLOSED in 4.7.5 (worker `2bdb8159`): the isolated-world boundary

**This was the actual root cause, and it explains every earlier attempt.**
Content scripts run in Chrome's **ISOLATED world**, which shares the DOM with
the page but **not JavaScript expandos**. The `__quill` property Angular sets
on `rich-textarea` lives in the page's own context, so `getQuill()` inside a
content script returns `null` **no matter how the lookup is written** — and
every isolated-world write (`textContent`, a synthetic `InputEvent`,
`execCommand`) is reconciled away by Angular, which is exactly the `ql-blank`
editor seen on every live run.

The fix uses infrastructure that was already there: `injected.js` runs in the
**MAIN** world (`"world": "MAIN"` in the manifest) and already speaks to
`content.js` over `postMessage`. Typing is relayed across that existing
bridge:

```
content.js  --TYPE_PROMPT_INTO_EDITOR-->  injected.js (MAIN)
content.js  <--PROMPT_TYPED (read-back)-- injected.js (MAIN)
```

`injected.js` drives `quill.setText(text, "user")` from the world that owns the
instance, and replies with the editor's actual text so the isolated side
verifies instead of assuming. A silent MAIN world times out after 5s and falls
back to the DOM writes, so it degrades rather than hanging.

`chrome.debugger` is **not** needed and was not added.

6 new tests: the relay posts the right envelope and cleans up its listener; a
silent MAIN world times out; a reply carrying someone else's `requestId` is
ignored; an absent window degrades; the DOM fallback still runs; empty prompts
are rejected.

> This also settles a question the 4.7.3 handoff left open — why
> `getQuill()` "was not found". It was never a missing property. It was the
> wrong world. No amount of selector work would have found it.

### LIVE RUN 3 (4.7.5, fresh `/app` conversation) — the collector fix landed

```
reason: no_response_rendered        (was: no_citations_in_response)
last_error: notebook_grounding_unverified:no_response_rendered
no type_prompt_failed in health    → the MAIN-world relay reported success
user-query: 0 · .ql-editor: ql-blank · chip: attached each run
```

Two things are now confirmed rather than assumed:

1. **4.7.4 works.** The reason is `no_response_rendered`, i.e. the collector
   found *no response newer than the snapshot*, on a conversation that had
   **zero** responses to begin with. The old code would have called this
   `no_citations_in_response` — it was grading a non-existent answer.
2. **The 4.7.5 bridge is being reached.** `type_prompt_failed` never appears in
   the health metrics, and that is only recorded when `typeAndSend` returns
   `ok:false`. So `setPromptTextAsync` returned true, which on this code path
   means the MAIN world replied `ok:true` with a non-empty read-back.

### But the text still does not survive

Sampling the editor during a live run, in sequence:

| t | observation |
|---|---|
| +6s | `.ql-editor` = `<p><br></p>`, `ql-blank` |
| +14s | `uploader-file-preview` present — attach done |
| +15.2s | `.ql-editor` still `<p><br></p>`, `ql-blank` |

So `quill.setText(text, "user")` ran, the MAIN world read the text back
successfully, and then **Angular reconciled the editor back to empty** before
the send-button wait. The MAIN world is the right place to call the API, but
the write is still being undone.

**The next question is narrow and testable:** does the text survive if the MAIN
world writes it and *waits* before reading back? The likely race is that
`setText` returns before Angular has re-rendered, the read-back sees the new
text, the send button is queried while the DOM is mid-reconcile, and the button
never appears. A short settle inside the MAIN world — re-read the editor after
a tick and report the *settled* value — would distinguish "Angular reverted it"
from "it landed and the button was just late". The latter is recoverable by
waiting for the button longer; the former means the write is being rejected
outright and needs a different mechanism.

### Follow-up worth noting

- Reload the extension after any `prompt-typing.js` edit. Reloading the
  Gemini tab is **not** enough.
- Keep the Gemini tab in the foreground. A hidden tab silently drops input.
### 3. Settle the MAIN-world write, then re-read (next concrete step)

Live run 3 on 4.7.5 confirmed the relay is reached (`type_prompt_failed` is
never recorded, and `setPromptTextAsync` can only return true when the MAIN
world replied `ok:true` with a non-empty read-back) — and that the text is
nonetheless gone by the time the send-button wait runs.

The narrow hypothesis worth testing: `quill.setText(t, 'user')` returns before
Angular has re-rendered, the read-back sees the *transient* value, and the DOM
is then reconciled back to `ql-blank`. The read-back therefore reports a write
that did not stick, which is the same class of false positive the rest of this
ticket has been about.

The fix is to make the MAIN-world read-back **settled** rather than immediate:
after `setText`, re-read the editor after a tick or two and report the value
that is still there. Then:

- settled text present → the write works and the send-button wait is the thing
  that needs more time;
- settled text empty → Angular is rejecting the write outright, and the DOM
  approach is a dead end.

That single measurement decides between "wait longer" and "different
mechanism", which is worth far more than another blind retry.

### Do not skip

### Action 3 — settled read-back + Angular model sync (4.7.6, worker `680ecc35`)

Consulted `agy1` (`~/.local/bin/agy1 --print "<prompt>"`) about the Angular +
Quill revert. It confirmed the mechanism independently and corrected two things
I had wrong:

**The mechanism.** `quill.setText(t, "user")` *does* emit Quill's `text-change`,
but called from a MAIN-world script it runs outside `NgZone`, so the
`ControlValueAccessor`'s `onChange` never reaches the `FormControl`. The form
value stays `""`, and the next change-detection pass calls
`ControlValueAccessor.writeValue("")` — which resets the editor. So retrying the
write only *flickers* against that loop; the value has to go into the model.

**`isTrusted` is the dividing line**, which is why CDP works and synthetic does
not:

| method | isTrusted | Zone.js hook | reaches Angular form |
|---|---|---|---|
| synthetic `new InputEvent` | false | partially | no |
| `quill.setText(t,'user')` | n/a (JS call) | no | no |
| CDP `Input.insertText` | **true** | **yes** | **yes** |
| CDP `Input.dispatchKeyEvent` | true | yes | yes |

It also confirmed `Input.insertText` is *preferred* over per-character
`dispatchKeyEvent` — the latter trips IME/modifier state.

**Two corrections it forced:**

1. My settled-ness check polled `innerText`. agy1's point is that `ql-blank` is
   the honest signal, because that class is literally what Angular restores. The
   code now reads the class.
2. I was about to ship a bare retry loop, which agy1 correctly warns "will fight
   Angular in an infinite flickering loop" while the model is `""`. The loop is
   now bounded *and* paired with `syncAngularModel()`, which uses
   `ng.getComponent` / `ng.getDirectives` / `ng.applyChanges` and tries
   `formControl`/`control`/`model`/`value`. The result reports **`ngSynced`**, so
   the next live run says definitively whether the Angular debug API was
   reachable.

### What the next live run will tell us

`ngSynced` is the decision variable:

- `ngSynced: true` → the model was reachable; the text should now survive, and
  the two consecutive `horo_consult` calls can proceed.
- `ngSynced: false` + `text_reverted_after_settle` → the debug API is stripped in
  this build and the DOM route is a dead end. **The only mechanism that produces
  `isTrusted` events without a debugger permission does not exist**, so the
  remaining option is `chrome.debugger` + `Input.insertText` — which is a
  permission change and must be asked for explicitly, not taken.

Either way the run is no longer ambiguous, which is the point.

### Do not skip

### LIVE RUN 4 (4.7.6) — the finding that reframes the ticket

Captured on the wire during the run:

```
20835.36541  POST …/StreamGenerate?bl=…&_reqid=264273&rt=c
             resourceType: "fetch"          ← the page's own calls are "xhr"
             no f.sid, no hl=th
f.req=[null,"[[\"Act as ซินแส AI ผู้เชี่ยวชาญโหราศาสตร์จีน (BaZi)…\",0,null,…],…]"]
             → NO notebook://…/sources/… ANYWHERE
```

**Replay had started working.** That falsifies the premise this whole ticket
was built on ("the assembled payload is rejected, so nothing ever leaves the
browser"). It now returns a perfectly good answer — and that is exactly the
problem:

1. the payload carries **no notebook reference**, so the answer is written from
   general knowledge by construction;
2. the page never renders it, so there is **no `model-response`** for the
   grounding check — hence 0 queries, 0 responses, and the honest
   `no_response_rendered` of 4.7.6.

Replay is **not a neutral fallback**. The attachment only exists in the request
the *page* builds, so a POST the bridge assembles itself can never carry it.

**Fixed in 4.7.7 (worker `52ff5312`):** `executeThroughExtension` takes
`requireGrounding`, set for a default-scoped `horo_consult`, and skips replay
outright rather than trying it and falling back. The typed path is the only one
in which the page builds the request — and the page is what carries the
notebook.

> This is the first version where the attach and the answer can come from the
> same request. Every earlier failure was partly an artifact of the wrong path
> being chosen.

### The `ngSynced` question is now the only one left

If the typed path is now actually taken, the 4.7.6 question becomes decisive:

- `ngSynced: true` → the Angular model was reachable; the text persists.
- `ngSynced: false` + `text_reverted_after_settle` → the debug API is stripped
  in this build, and since replay cannot ground, **only**
  `chrome.debugger` + `Input.insertText` remains. That is a permission change
  and must be asked for explicitly.

### Do not skip

### LIVE RUN 5 (4.7.7) — the chain completed end to end

| stage | evidence |
|---|---|
| attach | `last_attach_status = ok`, new `uploader-file-preview` each run |
| typed prompt landed | URL `/app` → **`/app/c717b39dd73233a4`**, a new conversation |
| query rendered | `user-query` present, titled *"หลักการนับวันเกิดและข้อจำกัดดวงชะตา"* |
| notebook travelled | `[data-test-id="filename-label"]` inside that `user-query` |
| answer streamed | full Thai BaZi answer in the newest `model-response` |
| **verdict** | `no_citations_in_response` ❌ |

**…but the answer was grounded.** The settled response carries **nine**
`source-inline-chip` elements, with `aria-label` reading:

> *"ดูรายละเอียดแหล่งที่มาของการอ้างอิงจาก **PDF: FORTUNE_original_lesson4.pdf**"*

That is a file from the Horo notebook. So 4.7.7 produced a correct, grounded,
notebook-cited answer, and the checker rejected it.

### The last bug: reading citations off a still-streaming response

Citations stream in **after** the text. `handleVerifyGrounding` read once,
immediately, so it judged a response that had not finished arriving. This is
the same class of error as every other layer of this ticket — a read taken too
early and reported as a settled fact — and it is the reason 4.7.6's "settle
before you believe it" rule was needed for the typing write too.

**Fixed in 4.7.8 (worker `e3ac578c`):** `handleVerifyGrounding` polls until
citations appear, and only concludes "ungrounded" after **three consecutive
samples** show the newest response unchanged. An unchanged response is a
finished one, so that verdict is a real answer rather than a guess. The worker's
budget rose to 35s to cover the wait.

### Where this leaves the ticket

Every layer now has live evidence behind it:

| version | defect | status |
|---|---|---|
| 4.7.1 | grounding never checked | fixed |
| 4.7.2 | previous turn's answer returned as this one | fixed |
| 4.7.3/5 | typed prompt never reached the editor (ISOLATED world) | fixed |
| 4.7.4 | answer not attributable to a request | fixed |
| 4.7.6 | settled read-back + Angular model sync | fixed |
| 4.7.7 | replay path used, which cannot ground | fixed |
| **4.7.8** | **citations read off a streaming response** | **fixed — needs a live run** |

Run 5 already demonstrated the hard part: a real prompt, sent through Gemini's
own input box, with the notebook attached, answered and cited from the notebook.
4.7.8 only stops the checker from rejecting it. The next run should return
`verified: true`, after which the two consecutive `horo_consult` calls — the
acceptance condition for KAN-182 — can be attempted.

### Do not skip

### LIVE RUN 6 (4.7.8) — run 1 PASSED, run 2 exposed the last race

**Run 1 — passed.**

```
✅ [answered] (46.9s)  1/1
last_grounding_status = grounded
last_grounding_reason = None
```

First successful `horo_consult` of the whole ticket: notebook attached, prompt
typed through Gemini's own input box, answer rendered, **nine citations from
`PDF: FORTUNE_original_lesson4.pdf`**, and `grounded` recorded. 4.7.8's
poll-until-settled change is what turned run 5's false negative into a pass.

> Note: the first attempt at this run failed with `tab_not_visible` — the
> visibility guard working correctly. Kapture's `show` does not reliably
> foreground the tab; `osascript -e 'tell application "Google Chrome" to
> activate'` does. Keep that in the resume steps.

**Run 2 — failed, `no_answer_rendered`, `responses on screen=3`.**

But the DOM showed **three** `user-query [data-test-id="filename-label"]`
elements, the newest visible — so the prompt *was* sent, with the notebook. The
answer was there; the collector could not attribute it.

The baseline was sampled in `handleCollectAnswer` — when the worker asked for
the answer. Gemini can render the response *before* that request arrives, so
the snapshot already contained the answer being waited for, and "nothing newer"
was the only thing it could possibly report.

**Fixed in 4.7.9 (worker `75249e36`):** the count is sampled in `typeAndSend`
**before** the send click and carried through `TYPE_PROMPT_RESULT` →
`collectTypedAnswer` → `COLLECT_ANSWER` as `responsesBefore`. The baseline now
predates the request it attributes.

> This is the same lesson as 4.7.8, and it is why KAN-182's acceptance
> condition is two *consecutive* calls: the single-call case never exercised
> this ordering.

### Remaining

Reload the extension and run `horo_consult` twice, back to back, with Chrome
foregrounded:

```bash
osascript -e 'tell application "Google Chrome" to activate'
node scripts/ask-each-skill.mjs --tools=horo_consult   # both must be grounded
```

Only then commit. Run 1 of 4.7.8 is genuinely in the record, but one pass is
not the acceptance condition.

## 11. ACCEPTED — KAN-182 (2026-09-29, 4.7.9)

Two consecutive `horo_consult` calls, back to back, both grounded:

```
run 1 → 1/1 answered ✅
run 2 → 1/1 answered ✅

last_attach_status    = ok
last_grounding_status = grounded
last_grounding_reason = None
attach_failures       = 0
consecutive_errors    = 0
```

`ping` and `check_bridge_health` also pass (2/2), so nothing else regressed.
This is the acceptance condition the handoff set in §9.

### Two operational notes from the final run

- **Foreground the tab with AppleScript, not Kapture.** Kapture's
  `show` reports `pageVisibility: hidden` even after it runs, and a hidden tab
  fails the visibility guard with `tab_not_visible`. This works:
  ```bash
  osascript -e 'tell application "Google Chrome" to activate'
  ```
- **A disconnected extension is usually just a sleeping service worker.**
  `DISCONNECTED` that does not recover after ~30s is fixed by reloading the
  Gemini tab (`kapture__compose` → `reload`, or the user pressing ⌘R); the
  content script re-runs and the bridge reconnects on its own. Do not go to
  `chrome://extensions` for this — verified not to be needed.

### The shape of the whole fix

Nine defects, all the same species — **a measurement taken at the wrong moment,
reported as a settled fact**:

| version | what was measured too early / too late |
|---|---|
| 4.7.1 | never measured grounding at all |
| 4.7.2 | previous turn's answer returned as this one |
| 4.7.3/5 | typed into the editor from the wrong JS world |
| 4.7.4 | answer not attributable to a request |
| 4.7.6 | editor read back before Angular reconciled |
| 4.7.7 | replay path used, which cannot carry a notebook |
| 4.7.8 | citations read off a still-streaming response |
| 4.7.9 | baseline sampled after the answer had already rendered |

Worth keeping as a rule: *before believing a DOM read, ask when it was taken.*
Every one of these looked like a working feature at the moment it was written.
