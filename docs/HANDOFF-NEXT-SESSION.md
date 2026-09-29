# Session Handoff — start here

> **Written:** 2026-09-29, at the close of KAN-182
> **Branch:** `main` · **HEAD:** `6a34b3b` · working tree **clean**
> **Production:** `https://prod.gemini-web-bridge.workers.dev` · **v4.7.9** · worker `75249e36`
> **Tests:** 409 passing, 0 failing
> **For:** whoever picks this project up next — you do **not** need to read the
> other handoffs to start, though §7 links them.

Read §1 and §2 before touching anything. §5 will cost you a day if you skip it.

---

## 1. Where things stand

KAN-182 is **done, committed, and verified live**. The `horo_consult` tool now
returns answers that are genuinely grounded in the HoroConsultant notebook, and
it says so honestly when they are not.

Nothing is in flight and nothing is half-applied. If you were told otherwise,
that is stale information.

### The verification that closed it

```
run 1 → 1/1 answered, grounded
run 2 → 1/1 answered, grounded      ← the actual acceptance condition

last_attach_status    = ok
last_grounding_status = grounded
last_grounding_reason = None
attach_failures       = 0
consecutive_errors    = 0

ping + check_bridge_health → 2/2   (no regression on other tools)
```

The answers cite `"PDF: FORTUNE_original_lesson4.pdf"` — a file from the
attached notebook — so the citations are real, not a count of stale chips.

---

## 2. What the project is

A Cloudflare Worker (Durable Object) bridges an MCP endpoint to a Chrome
extension, which drives an already-authenticated `gemini.google.com` tab. No
Google credentials are held by the bridge; the browser session is the auth.

Three worlds matter, and confusing them was the single most expensive mistake in
KAN-182 (see §5):

| layer | file | world |
|---|---|---|
| MCP/JSON-RPC, tools, health | `cloudflare-worker/src/index.js` | Cloudflare |
| Bridge logic, page interaction | `extension-cloudflare/content.js` | **ISOLATED** |
| Network interception, Quill access | `extension-cloudflare/injected.js` | **MAIN** (`"world": "MAIN"`) |
| Multi-tab leadership, WebSocket | `extension-cloudflare/background.js` | service worker |

`docs/HANDOFF-KAN-182.md` is the full working log for the last ticket (883
lines, chronological). Read it if you need the reasoning; do not read it to
learn the current state, because it is a log and the log ends in different
places.

---

## 3. Common commands

```bash
# build the extension (injects secrets; always run before loading in Chrome)
cd /Users/kimlenglim/Project/gemini-web-bridge
set -a; source .env; set +a
python3 scripts/build-extension.py

# tests  (expect 409 passing)
cd cloudflare-worker && npm test

# deploy the worker  (print the version id at the end)
cd cloudflare-worker && npx wrangler deploy

# live tool run
node scripts/ask-each-skill.mjs --tools=horo_consult

# health over MCP
curl -s -X POST https://prod.gemini-web-bridge.workers.dev/mcp \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $CLIENT_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"check_bridge_health","arguments":{}}}'
```

### Version bump is mandatory

A version bump touches **five places** and
`tests/version-consistency.test.mjs` fails the build if they drift:

```
cloudflare-worker/src/index.js          const WORKER_VERSION  (and the // Version: comment)
cloudflare-worker/package.json          version
cloudflare-worker/package-lock.json     version  AND  packages[""].version   ← both
extension-cloudflare/manifest.json      version
```

Then add a `CHANGELOG.md` entry. Use a patch bump for a correctness fix, minor
for a new capability. `build-extension.py` does **not** touch the three worker
files — they are always manual.

---

## 4. Before you run anything live

Two things will silently ruin a live test if you do not know them:

```bash
# 1. The Gemini tab must be the foreground tab. A hidden tab fails the
#    visibility guard with tab_not_visible.
osascript -e 'tell application "Google Chrome" to activate'

# 2. Kapture's show() does NOT foreground the tab — it reports
#    pageVisibility: hidden even after it runs. Use the osascript above.
```

Also: **reloading the extension at `chrome://extensions` is required** after
any change to `extension-cloudflare/*.js`, and reloading the Gemini tab is
*not* a substitute — content scripts are installed when the extension loads.
Kapture cannot reach `chrome://extensions`, so a human has to press the 🔄.

If the extension reports `DISCONNECTED` and does not recover within ~30s, it is
almost always a sleeping service worker, not a broken build. Reloading the
Gemini tab alone re-runs the content script and the bridge reconnects. Check
`node --check` on the built files before assuming the build is bad.

---

## 5. The lesson from KAN-182, and the traps still live

**Every one of the nine defects in that ticket was the same mistake: a
measurement taken at the wrong moment and reported as a settled fact.**

| what was read | when it was read | what it should have been |
|---|---|---|
| grounding | never | after the answer streams |
| the answer | after a timeout | bounded, and "no answer" said plainly |
| the editor | from the ISOLATED world | from the world that owns the instance |
| an answer's owner | from its text | from a response count taken before the request |
| the editor | immediately after the write | after Angular reconciled |
| citations | mid-stream | after the response stopped changing |
| the baseline | after the answer rendered | before the prompt was sent |

> **Before believing any DOM read, ask when it was taken.**

### Traps that are still in this codebase

- **A `querySelectorAll` count is only meaningful with a baseline taken
  before the action.** `native-recovery.js` and `prompt-typing.js` both
  depend on this; if you add a third such wait, thread the baseline the same
  way rather than re-snapshotting on arrival.
- **`injected.js` has no unit tests and cannot have any as written.** It is a
  side-effecting IIFE that patches `fetch` on load, so `require`ing it in Node
  throws `ReferenceError: window is not defined`. Its MAIN-world typing logic
  is covered by live runs only. Giving it a test harness is open work (§6).
- **`retryViaUi` must pass `minResponses: 0`.** Clicking "regenerate"
  re-renders the *same* `model-response`; a non-zero floor would make that path
  unresolvable. It looks like a bug and is not.
- **The replay path cannot ground anything.** It POSTs
  `f.req=[null,"[[\"<prompt>\",0,…]]"]` with no `notebook://…/sources/…`
  reference — confirmed on the wire. It is skipped when `requireGrounding` is
  set. Do not "optimise" it back into the grounded path.
- **A notebook attachment is consumed per message.** Attaching once per
  conversation was the original bug. Never reintroduce an
  "already attached, skip" short-circuit.

---

## 6. Open work, in the order I would take it

1. **Close KAN-182 on Jira.** It is fixed, committed and verified; the ticket
   is still open. Note that `docs/COMMIT_TICKET_MAPPING.md` records cases where
   a commit's ticket key does not match its work — check the ticket before
   closing it, not just the commit subject.
2. **Give `injected.js` a test harness.** The MAIN-world logic is the least
   covered part of the codebase and it is on the critical path for every
   grounded answer. A `window`/`document` stub is enough; the module is small.
3. **Decide what to do about the replay path.** It works, and it is the faster
   route for the SDLC tools, but it cannot ground. Either document that
   permanently, or make the assembled payload carry the attachment. The
   blocker is the `r_…` session token and ~40 inner fields in Gemini's real
   payload; a single captured payload is not enough to derive it safely.
4. **Auto-focus the tab.** The bridge currently requires a human to foreground
   Chrome before a grounded call works. Doing it from the extension would
   remove a real footgun. It is a small change and was deliberately deferred.

---

## 7. Reference

| document | what is in it |
|---|---|
| `docs/HANDOFF-KAN-182.md` | full working log for the last ticket, with live evidence |
| `docs/HANDOFF-KAN-176.md` | the refusal-detection and native-retry work |
| `docs/HANDOFF-KAN-168.md` | earlier bridge work |
| `ARCHITECTURE.md` | the three-world layout and the message flow |
| `GUARDRAILS.md` | **read before changing token handling** — the CSRF token must never leave MAIN-world memory |
| `docs/COMMIT_TICKET_MAPPING.md` | commits whose ticket key does not match their work |
| `CHANGELOG.md` | unified release line; 4.7.1–4.7.9 explain what each fix was |
| `README.md` | tool list and parameters |

## 8. Repo conventions

- Commits must cite a real `KAN-` ticket or `.githooks/commit-msg` rejects them.
  A pre-commit hook also scans for literal secrets and will fail the commit.
- Test harnesses load `src/index.js` via `vm.runInNewContext` with an explicit
  context. **A new module imported by `src/index.js` must be added to every
  harness.** The failure is `ReferenceError: <name> is not defined`, not an
  import error, so it points at the wrong place.
  **Do not work from a remembered list — 18 files do this:**
  ```bash
  cd cloudflare-worker/tests
  grep -ln "src/index.js" *.mjs helpers/*.mjs
  ```
- A test that stubs a successful `runNotebookAttach` must also stub
  `verifyNotebookGrounding`, or it waits out a 20s timeout and fails as though
  grounding were broken.
- **Selector discipline.** Never match a localized label, never match a list
  position, prefer `data-test-id` / class / icon name, and verify every selector
  by driving the real UI and re-reading the DOM. A selector read from a DOM
  sample is a hypothesis. This is not theoretical: a selector "verified" in
  KAN-176 matched nothing in production, so every wait silently degraded, and
  `generatingSignal()` turned out to match the sidenav's permanent chat-history
  loader — which made a wait that could never resolve look like an upstream
  outage.
- The UI here is in Thai. `aria-label="ส่งข้อความ"` is "Send message".
