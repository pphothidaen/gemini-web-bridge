# KAN-176 Session Handoff — Gemini refusals, native retry, prose prompts

> **Date:** 2026-09-28 · **Branch:** `main` · **Working tree:** clean
> **Production:** `https://prod.gemini-web-bridge.workers.dev` · **v4.4.3 → v4.7.0** (deployed)
> **Tests:** 335 → **364 passing, 0 failing**
> **Commits:** `59fc4bd`, `78c8ed0`, `52e5ad0`, `87a96ee`

This is a *session* handoff. The long-term architecture reference is the root
`HANDOFF.md` (still states v4.4.3 and predates everything below).

---

## 1. What was asked

Test every MCP tool ("skill") on `gemini-web-bridge` through browser tooling and
verify each question actually reaches Gemini — not just that HTTP returned 200.
Then fix whatever the testing exposed.

---

## 2. How to reproduce the environment

Two things bite immediately and cost real time if unknown:

```bash
# 1. The Chrome extension is NOT loaded from extension-cloudflare/.
#    It loads from dist/extension, and Chrome caches unpacked extensions.
cd /Users/kimlenglim/Project/gemini-web-bridge
set -a; source .env; set +a
python3 scripts/build-extension.py          # injects secrets -> dist/extension
# then: chrome://extensions -> Reload. A tab reload is NOT enough.
# (dist/extension hashes to dnapdkmdpjhpmnmpackekipejlfoplik — the ID seen in
#  the page console, which is how you can tell which copy is live.)
```

Secrets live in `.env` (`CLIENT_API_KEY` for the MCP endpoints). Never print them.

**Use Kapture, not chrome-devtools, to watch Gemini.** chrome-devtools runs an
automation-flagged Chrome (`--enable-automation --remote-debugging-pipe`) that
Google refuses to sign into ("This browser or app may not be secure"). It has no
usable tab. Kapture is attached to the already-authenticated `gemini-dev` profile.

---

## 3. The root cause, and the three things it was not

**The defect:** the bridge assembles its own `StreamGenerate` payload and POSTs
it from a MAIN-world script. Google's schema for that request has changed, so
Gemini now rejects the assembled payload for *everything* — including
`"What is the capital of France?"`.

**Hypotheses tested and falsified — do not re-investigate these:**

| Hypothesis | Falsified by |
|---|---|
| "The prompt is too robotic / not human-shaped" | Same refusal for `[Role: Expert Code Reviewer & Debugger]`, for plain prose, and for `"Say hello in one short sentence."` / `"What is the capital of France?"` |
| "Change `[Role:]` to `Act as`" | Byte-for-byte identical failure. Tested live. |
| "The code fence breaks it" | The same fenced snippet via `/v1/chat/completions` returned a correct, substantive answer. |

---

## 4. What changed

### 4.1 Measurement was lying (`scripts/ask-each-skill.mjs`)

Refusals arrived as ordinary `result` payloads inside HTTP 200, and the old
check only looked for `not ready | disconnected | please log in | unavailable`
— which never matched anything Gemini actually said. All 9 skills scored PASS.

Now classifies the reply and reports it as the verdict:

| verdict | meaning | retryable |
|---|---|---|
| `answered` | real answer | — |
| `upstream_error` | Gemini failed, or leaked its system preamble | yes |
| `soft_refusal` | polite decline | yes |
| `hard_refusal` | safety policy | **no** — re-asking cannot help |
| `transport_fail` / `rpc_error` | bridge / JSON-RPC failure | varies |

`ok` is now `verdict === "answered"`, not `text.length > 0`.
Skills run **sequentially** by default — the DO serialises generations behind
`requestBusy`, so parallel calls just queue into the 60s idle timeout and
produce phantom failures.

### 4.2 Native retry fallback (`extension-cloudflare/native-recovery.js`)

When the replay produces a retryable failure, the worker asks the extension to
click **Gemini's own retry control**, so Gemini builds the request itself. Three
attempts, 2s → 5s → 12s backoff, and only for classes a retry can change.

Selector is `model-response:last-of-type [data-test-id="regenerate-button"]` —
deliberately **not** `aria-label="ทำซ้ำ"`, which is localized.

### 4.3 Evidence registry dead-end (`extension-cloudflare/content.js`)

`horo_consult` failed 100% with *"Cannot execute unverified model mapping"*.
`EvidenceRegistry.invalidateAll()` wipes every mapping on a build-label change;
switching to a Notebook changes the label; and the worker sends
`EXECUTE_REQUEST` for MCP tools without ever calling `PREPARE_MODEL`, so
nothing ever re-verified. Extracted `autoVerifyStandardModels()` and call it
from the execute path before failing. **Fail-closed is preserved** — if
re-verification yields nothing, the request is rejected exactly as before.

### 4.4 Prose prompts (`cloudflare-worker/src/prompt-templates.js`)

Rewrote all five tool prompts from `[Role: ...] / Task: ...` field labels to
prose. Rationale: *Prompt Design at Scale* (arXiv 2607.19257, which benchmarks
Gemini Flash) finds **"Format Has No Reliable Winner"** for accuracy but that
**"refusal, not wrong recall, is what actually rises"** under structured
formats. Stated plainly: this improves answer quality, it did **not** fix the
outage (see §3). Code fences are kept and byte-preserved — indentation matters.

---

## 5. Three bugs that only live testing found

1. **Retry hit the previous conversation.** The worker retries ~2s after the
   replay, but Gemini was still navigating, so the click landed on the *prior*
   conversation's retry button and returned a healthy answer to the wrong
   question. Fixed with a settle wait plus a "does this look like a failure?"
   guard before clicking.
2. **Placeholder returned as an answer.** Gemini renders `"Gemini บอกว่า"`
   before streaming the real text, so a change-detector resolved on 13
   characters. Now waits for a real answer.
3. **The loading selector was dead.** A Lottie `clipPath[id^="__lottie_element"]`
   signal (supplied from a DOM sample) matched **nothing** over a real
   1500-word generation — every wait silently degraded to text-stability and
   short answers could be truncated mid-stream. The real indicator on this build
   (`boq-gemini-web-uiserver 20260927.05`) is Angular's Material spinner:
   `div.loading-content-spinner-container.ng-star-inserted` /
   `mat-progress-spinner.mat-mdc-progress-spinner`.
   `thinking-dots-animation` is **excluded** — it clears before the answer
   finishes.

`generatingSignal()` now reports *which* selector matched, and the extension logs
it: `[Bridge] 🔄 NATIVE_RETRY answered (signal=…, spinner=yes)`. A stale selector
is now visible instead of silent.

**Lesson worth carrying:** a selector copied from a DOM sample is a hypothesis,
not a fact. Every one of these passed unit tests against mocks while being
wrong against production.

---

## 6. Current results (v4.7.0, live)

| tool | verdict | note |
|---|---|---|
| `ping` / `check_bridge_health` / `list_bridge_models` / `set_bridge_scope` | answered | instant, no Gemini round-trip |
| `orchestrate_sdlc_plan` | answered | full Thai SDLC plan, ~690 chars |
| `evaluate_tech_tradeoffs` | answered | 2,000 chars, detailed comparison |
| `sdlc_solution_architect` | **intermittent** | passes or times out at 60s; a different tool fails each run |
| `code_review_and_debug` | **intermittent** | same |
| `horo_consult` | **non-functional** | see §7 |

Start of session: **0/9** answered. Now **7/9**, with the two failures rotating
between runs — i.e. upstream flakiness, not a per-tool defect.

---

## 7. OPEN: `horo_consult` is non-functional — and it is not a bridge bug

The notebook id `b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0` ("Horo") is a
**NotebookLM** notebook reached via `gemini.google.com/notebook/<id>`.

Verified in the live DOM:
- after a `horo_consult` call the notebook still holds **0** `user-query` and
  **0** `model-response` — no session is created;
- typing the same question **by hand into the notebook page**, bypassing the
  bridge entirely, also fails: the response sticks at `"Gemini บอกว่า"` and
  never completes, and the URL immediately moves to `/app/<new-id>`;
- the Gemini page makes **no** `notebooklm.google.com` requests at all — only
  its own `batchexecute?rpcids=whPPme&source-path=/notebook/<id>`.

So the NotebookLM-integration route (option ข) would inherit the same failure.
**The blocker is on Gemini's side for this account, not in the bridge.**

Detection is already fixed: the notebook phrasing of the system-preamble leak
(`"ฉันไม่ได้รับการโปรแกรมมาให้ทำเรื่องนี้"`) is now classified
`upstream_error`, so the tool can no longer report false success.

**Suggested next step, not yet decided:** open `notebooklm.google.com` directly
and ask the same question by hand. If that works, the fault is specific to
Gemini's notebook integration and a real integration becomes worth building. If
it also fails, it is the account, and `horo_consult` should be disabled with an
honest error rather than left looking healthy.

---

## 8. Still unfixed (deliberately)

- **The root cause.** The bridge still assembles its own `StreamGenerate`
  payload. Native retry is a working mitigation, not a fix: it costs ~13–21s
  (backoff + settle) versus a normal call. A real fix means learning the current
  schema from a captured native call and rebuilding the payload from it.
- **Intermittent upstream failures** on `sdlc_solution_architect` and
  `code_review_and_debug` (60s idle timeout). Not investigated beyond confirming
  they are not per-tool and not the code fence.

---

## 9. Useful commands

```bash
cd cloudflare-worker && npm test                       # 364 tests
cd .. && node scripts/ask-each-skill.mjs               # all 9, sequential
cd .. && node scripts/ask-each-skill.mjs --tools=horo_consult
cd .. && node scripts/native-recovery-smoke.mjs        # live end-to-end; may FAIL honestly
cd .. && python3 scripts/build-extension.py            # REQUIRED after extension edits
cd cloudflare-worker && npx wrangler deploy --name prod \
  --compatibility-date 2026-09-12 --compatibility-flag nodejs_compat
```

`native-recovery-smoke.mjs` is deliberately capable of reporting FAIL — it is a
real check, not a rubber stamp.

## 10. Conventions

- The version lives in four places and a test enforces it: `WORKER_VERSION` in
  `src/index.js`, `package.json`, `package-lock.json`,
  `extension-cloudflare/manifest.json`. Bumping needs all four.
- Test harnesses load `index.js` through `vm.runInNewContext` with an explicit
  context object. **Any new module imported by `src/index.js` must be added to
  the context in every harness** — `tests/helpers/mock-worker.mjs`,
  `tests/bridge-handshake.test.mjs`, `tests/multiplexed-protocol.test.mjs`,
  `tests/scope-switch-roundtrip.test.mjs`, `tests/tool-loop.test.mjs`,
  `tests/mcp-protocol.test.mjs`, `tests/sdlc-tool-args.test.mjs`,
  `tests/health-metrics.test.mjs`, `tests/red-team-adversarial.test.mjs`.
  The failure mode is `ReferenceError: <name> is not defined`, not an import
  error — it is easy to misread as a logic bug.
- Commits must cite a real Jira ticket (`KAN-176` here) or the governance hook
  rejects them.

