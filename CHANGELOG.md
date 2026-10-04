# Changelog

All notable changes to the Gemini Web-Bridge project.

> **Historical hosts.** This file names
> `gemini-web-bridge.pansakorn-pho.workers.dev` as the RETIRED pre-migration
> host. It is recorded as evidence only — do NOT use it to point a client
> anywhere. Production is `prod.gemini-web-bridge.workers.dev` and has been
> since commit `fa97a5d` (KAN-157).

## [4.7.35] - 2026-10-04

### Added
- **`horo_consult` atomic stage pipeline (KAN-204).** New `stage` parameter:
  one of `birth-chart` / `base-fortune` / `turning-points` / `forecast` /
  `additional-insights` runs a single notebook-grounded atomic request;
  `full` runs all five as a pipeline — fresh notebook attach per stage (the
  notebook is consumed per message), typed path, per-stage grounding
  verification with one retry, and per-stage answers persisted in DO storage
  keyed by a `reading_id` (SHA-256 of name + birth_context).
  `resume_reading: true` reruns only the stages that never grounded. A stage
  that keeps failing costs only its section: the document assembles from the
  grounded stages and the footer reports the failure. G-1 holds everywhere —
  the pipeline has no GCP fallback branch. Stage prompts are generated from
  `prompts/0*.md` by `scripts/sync-horo-prompts.mjs` into
  `src/horo-prompts.js` (the .md library is the source of truth; the
  generated module asserts the shared guardrail clauses at build time).
- **Thai-capable PDF export.** `buildAnswerPdf` embeds Noto Sans Thai
  (fetched once, cached in DO storage) via `@pdf-lib/fontkit` — previously
  every Thai glyph was replaced with `?` by the WinAnsi sanitizer. A failed
  font fetch degrades to the old WinAnsi behavior with a warning.

### Changed
- **`horo_consult` schema**: `query` is no longer schema-required — it is
  mandatory in the legacy free-form mode (validated at runtime with -32602)
  and optional in stage mode, where it is appended as a caller refinement.
  Stage-mode answers carry `structuredContent` (`reading_id`, `stage`,
  per-stage status) and a per-stage `notebookGrounding` map.
- The atomic prompt library was polished: shared guardrail block in all five
  stages (method-only opener, honesty clause, citation clause, Thai clause),
  fixed `##` assembly headings, count bounds for turning points and warnings,
  a พ.ศ.↔ค.ศ. conversion rule, and full field lists on the forecast
  fallback variants.

## [4.7.34] - 2026-10-04

### Added
- **Timing telemetry for `executeThroughExtension` (KAN-182).** The Durable
  Object's main Gemini execution path had no timing log at all — its
  `startTime` was captured and never used. All vlog-gated now (visible with
  `BRIDGE_VERBOSE=1`): a start line (message count + model), a took-line on
  the success exit, and the same took-line plus the error message on every
  error exit (extension disconnected, unhandled replay error, typed-path
  failure, collection failure) via a single `failWith` helper, so no future
  exit path can silently skip measurement. Only counts, model name and error
  messages are logged — never prompt or response content.

### Fixed
- **`callGcpGemini` took-line printed its expressions literally.** The log
  used `{endTime - startTime}` / `{messages.length}` (bare braces) inside a
  template literal, so it emitted the text verbatim instead of the elapsed
  time and could never match telemetry regexes. Fixed to `${...}`
  interpolation and relabelled from the misleading "Gemini API request took"
  to `[Bridge DO] callGcpGemini took`. Still vlog-gated.
- Tests: `winansi-and-verbose-logging.test.mjs` now asserts the exact
  `executeThroughExtension took` label with `${}` interpolation and that no
  broken `{endTime - startTime}` pattern remains in `src/index.js`.

## [4.7.24] - 2026-10-01

### Fixed
- **`waitForResponseChange` no longer spends its whole budget on the thinking
  phase.** During thinking there is no new `model-response` to count, so a flat
  wall-clock deadline expires on a generation that is proceeding correctly.
  The deadline is now idle-based — it slides while `isGenerating()` reports
  progress — bounded by a hard cap so a dead page still fails instead of
  hanging. Same split `runReplayAttempt` already uses for chunks. 3 tests,
  both directions asserted: it must slide for a live generation and still
  stop for a dead one.

### Known incomplete — read before relying on this
- **The worker-side timer was NOT hardened.** The timeout that actually fired
  in the observed failure is the `setTimeout` in `collectTypedAnswer`
  (`index.js`), still a flat 120s. The extension-side function was fixed; the
  caller-side timer was not. Whether the two together suffice for a
  notebook-grounded call that thinks for two minutes is **not established**.
- **The timeout message prints a wrong count.** It reads
  `lastCollectedResponseCount`, which is only set when a
  `COLLECT_ANSWER_RESULT` arrives. On the timeout path none had, so it prints
  `0` where the page held 5. Better than `undefined`, still not useful. The
  real number lives in the extension; the worker never asks before giving up.

Neither has been shown to fix the original symptom end to end. See KAN-236.

### Observed but not a bridge defect
The 120s+ failure reproduced on a conversation that had accumulated six turns.
The same call on a fresh conversation completed the full lifecycle in 12
seconds (`thinking-dots=1, aria-busy=0` → `aria-busy=1` → 515 → 1587 → 1873
chars). The bridge was waiting on a page that had stopped producing answers.

`horo_consult` also refused that fresh run with `no_citations_in_response` —
the KAN-204 fail-closed path, working as intended. The prompt was verified
intact at 749 chars, so the refusal was not truncation.

## [4.7.23] - 2026-10-01

### Fixed
- **`isGenerating()` was silent during the thinking phase.** The shipped signal
  is `[aria-busy="true"]` scoped to the newest `model-response`. Measured
  2026-10-01 across one real generation, that is false for the whole thinking
  phase — and during that phase there is no new `model-response` at all, so the
  scope has nothing to look at:

  | phase | `aria-busy` | `model-response` | `thinking-dots` |
  | :--- | :--- | :--- | :--- |
  | T1 thinking | **0** | 3 (unchanged) | **1** |
  | T2 streaming | 1 | 4 | 0 |
  | T3 settled | 0 | 4 | 0 |

  So between "prompt submitted" and "aria-busy fires" the extension reads a
  settled-looking page. `aria-busy` proxies *streaming*; the question is
  *generating* — KAN-197/198's shape one level up.

  `generatingSignal` now also reports a visible thinking indicator, placed
  AFTER the response-scoped block so it fires only when the newest response
  looks settled and something is still pending. Checking it first would let it
  mask `response_aria_busy`.

  It cannot latch the way 4.7.13 did: `thinking-dots-animation` is transient,
  removed the moment streaming starts, unlike `has-thoughts` and
  `processing-state-visible`, which are permanent.

### Added
- **`tests/native-recovery-thinking.test.mjs`** — 6 tests driving the real
  `generatingSignal` against a stub built from the capture: true while
  thinking, true while streaming via `response_aria_busy`, false once settled,
  false at the input surface in both editor states, and an explicit regression
  test that the permanent classes still mean nothing.

  Mutation-checked. Removing the thinking check fails exactly one test.
  Swapping it for `processing-state-visible` — reproducing 4.7.13 — fails
  three.

### Fixed in the test harness
- **A captured node had no `querySelector`.** The extension calls
  `response.querySelector(...)` on the node returned by `querySelectorAll` and
  takes a `typeof === "function"` guard, so the stub made `isGenerating()`
  report "not generating" for a streaming response the fixture clearly shows
  as busy. A stub that under-reports matches is the same failure as one that
  over-reports them.

### Fixed in the capture
- **Responses were ordered newest-first.** `lastModelResponse` takes
  `all[all.length - 1]`, so document order decides which response counts as
  newest. The live page appends below, oldest-first; the capture did not. A
  test now asserts the ordering, because getting it wrong makes a correctly
  scoped query look at the wrong response.

- `npm test` → 619 tests / 613 pass / 0 fail / 5 skipped
- Extension rebuilt at `dist/extension` (v4.7.23). **It must be reloaded at
  `chrome://extensions` before this takes effect** — the worker deploy does not
  touch it.

## [4.7.22] - 2026-10-01

Ships the two changes recorded under `[Unreleased]`:
`/v2` routing with a frozen `/v1` (KAN-234) and the health-counter fix that
`horo_consult` could never previously clear (KAN-233). Bumped separately from
4.7.21 so a client that sees `/v2` answer can identify which build introduced
it.

## [Unreleased]

### Fixed
- **`PAYLOAD_CAPTURE_ARM` never reached the page.** The payload-capture relay
  shipped in 4.7.28 with only its upward half wired: the record could travel
  page → content → background → worker, but the arm could not travel back down,
  because `PAYLOAD_CAPTURE_ARM` was missing from `background.js`'s
  forward-to-active-tab group. `POST /debug/payload-capture` returned
  `{"armed":true}` and flipped the DO flag, and no capture ever arrived.

  Caught by running it against production rather than by reading the chain. Half
  a two-way relay looks exactly like a working one in a diff, and the endpoint
  reporting success made it worse — the failure was a silence, not an error.
  A regression test now asserts both directions separately, and its mutation
  (unhooking the downward arm) is confirmed failing.

### Added
- **`/health` now reports the extension's collection heartbeat.** A new
  `collection` block carries `last_progress_at`, `last_progress_responses` and
  `last_progress_generating`, stamped by the worker when a
  `COLLECT_ANSWER_PROGRESS` arrives.

  This exists because verifying the 4.7.25 heartbeat otherwise required opening
  the Gemini tab's DevTools console — a manual step, and one whose reader proved
  unreliable: during the 4.7.26 verification attempt it returned zero entries
  even immediately after a page reload, having returned 58 earlier in the same
  session. An instrument that can report "nothing happened" when it has simply
  detached cannot support a conclusion.

  With this, the extension-reload check is one `curl` and needs no browser.
  **Run a call first, then read it** — the ordering matters:

  | `collection.last_progress_at` | meaning |
  |---|---|
  | recent timestamp, after a call | 4.7.25+ extension is live |
  | `null`, after a call completed | extension loaded but not heartbeating — a real fault |
  | `null`, no call since the last deploy | **inconclusive**, not a fault |

  That third row is worth reading twice. The field is **in-memory DO state**, so
  a deploy restarts the Durable Object and resets it to `null` — observed
  straight after run `36969590860`, where a healthy, fully loaded extension
  reported `null` purely because nothing had been collected since the restart.
  Reading that as "the extension is stale" would raise a false alarm on every
  single deploy. Hence "run a call, then check": only a *completed* call that
  leaves the field `null` is a genuine failure.

  `null` is deliberately distinct from `0`. `lastCollectedResponseCount` alone
  cannot tell "a heartbeat reported zero responses" from "no heartbeat has
  arrived during this DO's lifetime", and that ambiguity is exactly what made the
  extension half unverifiable. The field starts `null` and is only written on
  arrival.

  Pinned by two tests, including a mutation that removes the health block and
  fails.

### Fixed
- **The 4.7.25 heartbeat is now observable.** The extension's
  `COLLECT_ANSWER_PROGRESS` sent every 3 s and logged nothing, which left the
  extension half unverifiable in practice: after a reload there was no way to
  tell the new build from the old one, because the worker's deadline slide stays
  invisible whenever a generation finishes inside the flat 120 s budget — which
  is every healthy run. One `[Bridge] 💓 COLLECT_ANSWER_PROGRESS active` line per
  collection, latched so a long generation does not flood the console. Pinned by
  a test, because the honest reason it was added is that it was missing.
- **The CD watchdog issue body no longer tells operators to make an approval
  call that returns 422.** `cd-watchdog.yml` printed the `pending_deployments`
  POST without the `comment` field, which the API requires — a reader copying
  that block got `"comment" wasn't supplied` and the run stayed stalled, with
  nothing in the error naming the field. `docs/CD-STALL-RUNBOOK.md` already
  documented it correctly, but the watchdog's own issue is what a stalled-run
  responder reads first. The env-id lookup also now uses `--jq` so it prints the
  id rather than a dump to copy from.
- **`prompt-typing.json` now records that `sendButtonFallback` does match.** The
  handoff claimed it "matched zero elements in every captured state". That was
  measured against an *empty* editor, where Gemini renders no send control at
  all — so both the primary and the fallback returned nothing, and the fallback
  looked dead for a reason unrelated to it. Re-measured with text present via
  Kapture `elements`: the fallback matches one `gem-icon-button.send-button`
  (classes include `lm-enabled`, `has-input`, `submit`) at the same 919.5/594
  32×32 bounds the primary's inner `button` resolves to.

  The recorded cause is that `states.filled` captured the `arrow_upward`
  `mat-icon` but omitted both its parent `button` and the
  `gem-icon-button.send-button` wrapper — a tree from which the fallback's match
  could not have been derived, which is exactly why the zero-match claim looked
  credible. The fallback is kept: it is an independent hook on a different
  element that survives a Material internals change, which is what it was added
  for.
- **`collectTypedAnswer`'s deadline is now idle-based, and its timeout reports
  the page's real response count.** Two defects the 4.7.24 entry recorded as
  "known incomplete", both in the caller-side half that the KAN-236 extension
  fix never covered — the extension slid its own deadline while the worker kept
  a flat 120 s, and the worker is the timer that actually fired.

  The extension now sends `COLLECT_ANSWER_PROGRESS` every 3 s while a
  collection is in flight, carrying both the live `model-response` count and
  whether `isGenerating()` reports work happening. The worker re-arms from
  those, so a generation that is progressing is not cut off at the flat budget.

  Measured 2026-10-02 on three grounded `horo_consult` calls: StreamGenerate ran
  **36151–38353 ms** before the answer rendered, so the old flat timer left about
  3.2× margin on a fast grounded answer and nothing on a slow one.

  Three things this deliberately does **not** do:

  - A heartbeat reporting `generating: false` does not extend anything, so an
    idle or hung page still times out on schedule.
  - `hardCap` (`max(timeout×3, timeout+60000)`) is **enforced**, not merely
    allowed to stop the slide. The first version stopped sliding past the cap
    and left the already-armed timer in place, which reached 117 s against a
    90 s cap and never returned — a hang is worse than the timeout being fixed.
  - The slide is anchored to a fixed origin (`startedAt + timeoutMs + elapsed`,
    capped). The first version recomputed a *duration* per heartbeat and re-armed
    it from the current clock, which compounds: the wait grew geometrically to
    204 s in 100 s of virtual time and never settled.

  The timeout message now prints the count the page actually reported instead of
  `responses on screen=0`. `lastCollectedResponseCount` was only ever written
  when a `COLLECT_ANSWER_RESULT` arrived, which by definition has not happened on
  the timeout path. It also carries `waitedMs`, so a deadline that slid is
  distinguishable from one that did not.

  9 new tests in `collect-typed-answer-worker-deadline.test.mjs`, including the
  three mutations above, each observed to fail and then reverted.

  `collectTypedAnswer` now takes injectable `now` / `setT` / `clearT`, matching
  the pattern `waitForResponseChange` already uses. Defaults are the real
  globals, so no production caller changes behaviour.

### Added
- **`/v2` exists as a place to make a breaking change without making one.**
  `/v2/models` and `/v2/chat/completions` are open and currently return
  byte-identical bodies to their `/v1` counterparts. The prefix is stripped
  once, at the top of `fetch()`, so both versions read the same handler —
  there is no second copy of the logic to drift.

  The point is not the endpoint. It is that `/v1` is now *frozen by
  construction*: there is a named place for a breaking change to go, so the
  temptation to reshape `/v1` in place has somewhere better to go instead.

- **`api_version_contract.test.mjs` (13 tests)** pins the `/v1` response shape
  field by field, asserts `/v1` and `/v2` return identical bodies, and asserts
  an unknown version is named (`unsupported_api_version`) rather than 404ing
  the same way a typo does.

- **`/health` advertises `api_versions`** — `supported`, `default`, and an
  empty `deprecated` map, so a client can discover which versions exist
  without reading the source.

### Changed
- **Version routing is resolved in one place.** The four literal
  `url.pathname === "/v1/..."` comparisons became one `resolveApiVersion()`
  call. Nothing about `/v1` behaviour changed; this only makes "v1 and v2 are
  the same handler" a structural fact rather than a coincidence.

### Security
- **The auth gate stays keyed on the literal request path, not the
  version-stripped one.** Keying it on the stripped path would have made
  `/v1/health` inherit public access from the `/health` allowlist entry and
  leak the whole health report — model ids, scope, connection state — to
  anyone. Pinned by a dedicated test.

### Notes
- **Not deployed at the time of writing**; `wrangler deploy` is left to the
  operator as always. In production today (4.7.21) `/v2/models` returns the
  generic 404, because `4.7.21` predates this change — the router is in the
  repo, not in the running worker. `/v1` behaves identically either way, which
  is the property that made this safe to ship un-deployed.
### Fixed
- **`/health` stayed `degraded` forever after a successful `horo_consult`.**
  `recordHealthSuccess()` was called only from the replay stream's
  `STREAM_DONE` branch. A grounding-required call throws
  `replay_skipped_for_grounding` before the replay stream starts, so it
  always takes the typed path — and the typed path had two
  `recordHealthError` calls and no success writer at all.

  Measured live on 2026-10-01: a fully successful grounded call
  (`verified: true`, 5 citations, 7537 chars) left `/health` reporting
  `degraded` with `consecutive_errors: 3` and
  `last_successful_generation: null` — the exact values left by three
  earlier failures. Three transient errors pinned the bridge to `degraded`
  permanently, because the only caller that could reset the counter was the
  one caller that path never reaches.

  Fixed at the single exit both paths reach, after the verdict check, so a
  future third path cannot forget to.

- **An empty generation counted as a success.** `classifyGeminiReply("")`
  returns `ANSWERED` — it is a text classifier matching refusal patterns, and
  an empty string matches none. An empty answer therefore fell into the
  success branch and stamped `last_successful_generation`, so a bridge
  returning nothing would have reported itself healthy. Empty is now recorded
  as `empty_answer`, and the stale success stamp from the replay path's
  `STREAM_DONE` is cleared when the verdict is a refusal or an empty answer —
  otherwise `/health` reported both a success and an error for one generation.

- **`tests/health-counter-reset.test.mjs`** — 9 tests. Five drive real round
  trips through `/health`; four force the typed path directly, which is the
  branch the defect lived in.

### Notes on the typed-path tests
The first version of that file drove every assertion through
`POST /v1/chat/completions`. All five tests passed — **and deleting the
single-exit success write entirely also passed all five**, because the mock
extension answers over the replay stream, whose `STREAM_DONE` carries a
success writer of its own. A green suite that cannot fail is worse than no
suite, because it reads as coverage. The typed-path tests exist because of
that observation; the round trips are kept because they still pin the
`/health` surface an operator reads.

With them in place the same mutation reds exactly one test, and disabling the
empty-answer branch reds two. Verified by mutation, reverted after each.

- `npm test` → 613 tests / 608 pass / 0 fail / 5 skipped
- Not deployed; `wrangler deploy` is left to the operator as always.

### Changed
- **Every GitHub Actions pin was moved off the removed Node 20 runtime.**
  23 pins across all five workflows targeted Node 20, which reached end-of-life
  in April 2026, defaulted runners to Node 24 on Jun 16, and was **removed from
  GitHub Actions on Sep 23 2026** — eight days before KAN-227 was filed.

  Every pipeline had been green only because GitHub was still routing these
  actions onto Node 24 through a forced fallback past the removal date. That is
  the state where everything works and nothing says why, which is the state that
  tends to fail at the worst moment.

  | action | from | to | count |
  |---|---|---|---|
  | `actions/checkout` | `@v4` | `@v7` | 12 |
  | `actions/setup-node` | `@v4` | `@v7` | 6 |
  | `actions/setup-python` | `@v5` | `@v7` | 3 |
  | `actions/upload-artifact` | `@v4` | `@v7` | 1 |
  | `gitleaks/gitleaks-action` | `@v2` | `@v3` | 1 |

  **Every runtime was read from `runs.using` in the upstream `action.yml` at the
  specific tag, not from release notes.** That distinction is load-bearing:
  `upload-artifact@v5`'s release notes read *"**BREAKING CHANGE:** this update
  supports Node `v24.x`"* while its `action.yml` says `using: node20`. A bump
  that trusted the notes would have looked correct, been recorded as done here,
  and left the repo on the removed runtime one pin short of the goal.

  Each workflow was bumped in its own commit so a failure names its cause, with
  `cd.yml` last because it is the single deploy authority. `NODE_VERSION` is
  untouched — that is the project under test, not the actions' own runtime.

- **Every job now runs on an explicit image label.** All 13 `runs-on:`
  declarations used the floating `ubuntu-latest`, which upstream rolls to Ubuntu
  26.04 beginning Oct 19 2026 ([runner-images#14748]). A floating label means the
  image moves underneath the repo with no commit and no diff to review.

  Per KAN-228, this migrates deliberately to `ubuntu-26.04` **now**, while
  `ubuntu-latest` is still 24.04 — upstream's own recommendation, and the reason
  a regression is attributable to the image rather than to the label shifting.

  | | Ubuntu 24.04 | Ubuntu 26.04 |
  |---|---|---|
  | OS | 24.04.5 LTS | 26.04.1 LTS |
  | kernel | 6.17.0-1022-azure | 7.0.0-1012-azure |
  | systemd | 255.4 | 259.5 |

  Docker, Minikube, the AWS/Azure/GCloud CLIs, Rust, Firefox and Java are
  identical across both images, so the exposure is concentrated in the kernel and
  init system rather than the toolchain.

### Added
- **`.github/dependabot.yml`** — the thing that was listening while nobody was.

  KAN-227 was found by reading a deploy log. The Node 20 deprecation warning
  had been present in *every* run of *every* workflow since April 2026, and
  nobody saw it for six months. The signal existed; nothing was watching. The
  repo has never had a Dependabot config.

  This closes a specific hole KAN-227's guards deliberately leave open.
  `action-runtime-pins.test.mjs` pins a **floor**, so it catches a pin going
  backwards — an edit re-introducing `@v4`. It cannot catch a pin going
  **forwards**: when `actions/checkout@v8` ships, the floor test stays green,
  the deprecation banner does not return, and the repo is again N majors behind
  with nothing announcing it. Same failure, opposite sign — and the more likely
  one, since upstream ships majors roughly quarterly.

  The two mechanisms are complements, and both are load-bearing:

  | | answers |
  |---|---|
  | `dependabot.yml` | does a new major **exist**? |
  | KAN-227 floor guard | is this pin **too old**, once you decide to move? |

  Config choices worth stating, because each is a decision rather than a default:

  - **weekly, not daily.** Five workflows, one operator, and upstream releases
    roughly quarterly — a daily stream would arrive empty almost every week,
    and a stream that is usually empty is one whose signal gets dismissed.
  - **no `ignore:` block.** Ignoring majors would guarantee the repo never
    learns one exists — the KAN-227 failure, automated. `version-update:false`
    is asserted against for the same reason.
  - **grouped per action.** `actions/checkout` appears 12 times; ungrouped, one
    major opens 12 PRs and 12 chances to merge eight of them.
  - **`open-pull-requests-limit: 10`,** not the default 5, which would
    auto-close the oldest PR during a burst of majors — possibly one mid-review.

- **`cloudflare-worker/tests/dependabot-config.test.mjs`** (7 tests) pins the
  config, because either mechanism can be deleted alone while the other still
  looks complete — which is how a guard becomes decorative. Verified against 9
  mutations: deleting the config, pointing it at `npm`, a wrong `directory`
  that parses cleanly while watching nothing, removing the schedule, adding an
  `ignore` block, dropping the groups, reverting the PR limit to 5, switching
  to daily, and deleting the KAN-227 floor guard it complements.

- **`cloudflare-worker/tests/action-runtime-pins.test.mjs`** and
  **`cloudflare-worker/tests/runner-image-pins.test.mjs`** (16 tests) pin both
  properties, so the next pin that re-introduces `@v4` — or the next
  `ubuntu-latest` — fails CI instead of shipping.

  KAN-227's own note was the finding: *"Nothing in the repo asserts anything
  about action runtime versions, so a future pin re-introducing @v4 would pass
  every test."* Both guards were written **before** the workflow edits and
  observed failing first, then mutation-verified: reverting a pin, setting the
  `upload-artifact` floor to 5, restoring a `with:` block on the gitleaks step,
  making the gitleaks checkout shallow, restoring a floating label, adding a
  branch-ref pin, and splitting the runner set across two majors each turn the
  suite red with the mutation named.

  Two of those checks caught real defects in the guards themselves — a SHA
  beginning with a digit parsed as `major: 8` and sailed past every floor, and a
  job-boundary regex anchored at column 0 swallowed the whole file so its
  assertions passed on unrelated content. Both are now guarded, because a guard
  that silently checks nothing is the failure mode these tickets exist to stop.

  The runtimes live in `tests/helpers/action-pins.mjs` as a literal with a
  `measured` date, not as a fetch: CI job 0 runs before any `npm ci`, and a
  guard that needs network access is a guard that can fail open.

### Fixed
- **Every extension build was labelled with a version a month stale.** Releases
  4.7.0 through 4.7.21 all shipped without a git tag, and `ci.yml`'s
  `Determine version` derives `MAJ.MIN.PAT` from the newest `v[0-9]*` tag. With
  `v4.4.3` as the newest tag, CI published `4.4.3.<run>` on a `4.7.21` codebase.

  It stayed invisible for three reasons worth recording. `4.4.3.116` reads like
  a deliberate pre-release scheme rather than an error. The build stamp
  (`dist/extension/BUILD.json`) agreed with the manifest and said `4.7.21`, while
  CI named the artifact `4.4.3.x` — two authorities, each internally consistent,
  disagreeing, so `build-extension.py --verify` passed and could not have caught
  it. And nothing asserted that a release ever gets tagged.

  Tagged `v4.7.21` on `666c577`, the commit declaring that version in both
  `package.json` and `manifest.json`, which live `/health` confirms is what
  production runs.

  At the operator's direction the eleven intermediate releases were then tagged
  too: `v4.7.0`, `v4.7.9`–`v4.7.18`. **Each of those tags records its own
  provenance in its message**, because they are not the same kind of evidence as
  `v4.7.21`: verified is the version the commit declares, in both files;
  unverified is whether that commit ever reached production. The repo keeps no
  deploy history and the version field is not a 1:1 release counter (it skips
  4.7.1–4.7.8 and 4.7.19–4.7.20), so "the version changed" does not imply
  "released to prod". The tags are version-line markers, and they say so, so
  nobody later mistakes one for a deployment record. `v4.7.21` is the only tag
  carrying live confirmation.

  The tag alone only fixes today. `Determine version` now **fails closed** when
  the tag base is behind `package.json`, so the next forgotten release line goes
  red in CI instead of shipping a misleading label — a warning would be
  invisible in a green run, which is how this shipped in the first place.

- **`cloudflare-worker/tests/extension-version-line.test.mjs`** (6 tests) pins it.
  Two assert the repo state (newest tag matches the manifest; each tag sits on a
  commit declaring its own version). Two read the workflow to require the guard
  to exist and to `exit 1` rather than warn. Two **execute the real `LOWEST`
  expression** lifted out of the workflow against version pairs — `sort -V`
  ordering, the lexicographic trap where `4.9.0` would wrongly sort below
  `4.10.0`, and a major bump — because reading the source proves the guard is
  written down but not that its arithmetic is right. Verified in both
  directions: deleting the tag turns the suite red.

- **The retired production host was still copy-pasteable, and a wrong host
  fails silently.** A client pointed at
  `gemini-web-bridge.pansakorn-pho.workers.dev` reported a broken
  `/v1/models` — `data: []`, `default_recommended: null`,
  `status: "disconnected"`. That is not a defect: it is the *correct* answer
  from the pre-migration account that `fa97a5d` left running as a rollback
  target. The host is v4.4.3 with `epoch_counter: 0`; the extension left it
  during the migration and only ever connects to
  `prod.gemini-web-bridge.workers.dev` (v4.7.21,
  `CONNECTED_AND_READY`), which serves 3 models and answers
  `/v1/chat/completions` normally.

  What made this worth fixing rather than repointing once is that the retired
  host **still answers 200, still serves `/mcp`, and still lists all 9 MCP
  tools** — so nothing errors. The only tell is `version` in `/health`, and
  the first symptom is an empty catalogue arriving at the caller with no
  explanation. 15 tracked files still named it, including copy-pasteable
  client config in `IDEA.md`, the health-check step in `PLANNING-HANDOFF.md`,
  and — worst — the verification curls in the rotation runbook
  `docs/SECURITY_TOKEN_ROTATION.md`, which would have "confirmed" a rotation
  against a worker that never sees production traffic.

  Actionable references are repointed to the canonical host. Files that are
  genuine historical evidence keep the old host and gain a banner saying so
  rather than being silently rewritten: falsifying which host a dated
  verification run exercised would destroy the evidence it exists to provide.

- **`IDEA.md` documented a model id that no longer exists.** The client setup
  blocks told people to set `default: gemini-web-thinking` /
  `Model: gemini-web-thinking`, a hardcoded id the worker stopped serving once
  the catalogue became dynamic (`cloudflare-worker/README.md` already said so).
  They now point at `GET /v1/models` and `default_recommended`, so the next
  catalogue change cannot leave the docs naming a retired id.

### Added
- **`cloudflare-worker/tests/production-host.test.mjs`** — the invariant, now
  enforced. A one-time sweep decays: the next doc edit reintroduces the old
  host and nothing notices, because no code path is involved for a human to
  get wrong. The test fails if any *committable* file names the retired host
  outside an explicit allowlist whose every entry carries both a reason and a
  reader-visible warning, and it re-derives that file set from
  `git ls-files --cached --others --exclude-standard` so ignored secrets and
  build output cannot drift into scope. A final test asserts the scan is not
  vacuous — a governance test that silently scans nothing is worse than none,
  because it goes green forever. Verified in both directions: a planted
  offending file turns it red.

### Changed
- Deleted `artifacts/production-live-mcp-verification.json` at the repo root —
  byte-identical to the tracked `cloudflare-worker/artifacts/` copy and, sitting
  under a gitignored path, unreachable from any commit anyway.

## [4.7.18] - 2026-09-29

### Fixed
- **Answers were being cut off, and the bridge reported success.** Four
  consecutive `orchestrate_sdlc_plan` calls over production returned 442,
  4,227, 4,892 and 6,735 characters; three ended mid-sentence or mid-table.
  The decisive observation: the DOM response measured 26px while the MCP
  caller received 6,735 characters — the two are not the same text, because
  the replay path is a separate request from the one the page renders.

  The cause is `adoptText` in `runReplayAttempt`, which drops any update that
  does not extend the accumulated prefix. That is correct for the side-entry
  frames Gemini appends, and it is also what loses a continuation; the
  comment above `decodeChunk` already records this class of failure for
  `orchestrate_sdlc_plan`, fixed for the link-only shape but not the
  truncated-prose shape.

  Every MCP tool now goes through the typed path. The routing is
  unconditional rather than `requireGrounding: true`, because the four
  ungrounded tools are the ones that truncate. The typed path renders into
  the DOM and is read back whole — which is why `horo_consult`, the one tool
  already on it, was the one returning complete prose.

- **A run that worked but was quietly wrong had nowhere to report itself.**
  `check_bridge_health` read `healthy` with `consecutive_errors: 0` through
  all four truncated answers. A health *signal* now exists alongside errors:
  it records a caveat without claiming a failure, does not touch the error
  counters, and is surfaced as `last_signal` in the health report. Replay
  dropped-update counts are recorded through it, so the OpenAI-compatible
  endpoints — which have no typed equivalent — are no longer silent.

### Notes
- Replay is not removed. The `/v1/chat/completions` family still uses it, and
  the signal is how an operator learns their answer may be incomplete.
- Not deployed at the time of writing; `wrangler deploy` is left to the
  operator as always.

## [4.7.17] - 2026-09-29

### Added
- **T3, the capture that could not be transcribed.** `source-inline-chip` —
  the selector that decides grounded vs not — had been evidenced only by a
  count (chips 7, 8) since KAN-182. It is now captured from a live
  notebook-grounded answer, and the capture settles two things a count
  could not: `source-inline-chip` is a custom element whose **tag name** is
  that string, not a class, and the earlier response in a two-turn
  conversation renders no chips at all while the newest renders three. The
  contract now checks real states for it instead of claiming none.
  Structure only is recorded; the chip's `aria-label` carries the notebook
  source filename and is stored as present-with-value-withheld, since a
  committed fixture must not hold text.

### Verified
- **v4.7.16 answers end to end.** A live `horo_consult` run collected in
  ~58s where 4.7.13 burned its full 120s budget, and reported
  `VERIFY_GROUNDING grounded (chips=3, cites=0)` on a 2,316-character
  answer. The `aria-busy` fix is confirmed against the running extension,
  which is the first end-to-end confirmation of any fix from this series.

### Notes
- Not deployed. The worker still runs 4.7.11.

## [4.7.16] - 2026-09-29

### Fixed
- **The grounding check claimed two independent signals and had one.**
  `readGroundingEvidence` counts `source-inline-chip` elements and
  `[cite: N]` markers, and the comment called them independent: either was
  enough to call an answer grounded. On every grounded run recorded
  2026-09-29 the chip count was 7 or 8 and the marker count was 0 - so the
  marker branch has never been taken, and the chip selector has been
  carrying the entire decision alone. A branch that cannot fire is not a
  second opinion; it is decoration that made a weaker check look stronger.
  Both signals are now declared in the DOM signal contract with the counts
  that establish this, and a test fails if either claim is quietly upgraded.

### Added
- **A sweep that ends the open-endedness.** Fixing did not terminate because
  each fix exposed the next unverified selector, and the contract covered
  four of roughly twenty. Every load-bearing selector the extension reads is
  now either confirmed working by live console evidence or confirmed absent
  on this build, recorded in `tests/fixtures/observed-selectors.json`. A test
  walks the load-bearing list and fails on any selector with no evidence, so
  a new selector added without a measurement is caught here rather than in
  production.

  The fixture is counts and step results, not a DOM capture, and says so
  plainly. Presenting it as a capture would repeat the mistake it fixes.
  A true DOM capture of the attach flow and prompt box remains open as the
  one measurement that cannot be transcribed.

### Notes
- Not deployed. The worker still runs 4.7.11; `wrangler deploy` is left to the
  operator.

## [4.7.15] - 2026-09-29

### Added
- **A DOM signal must be backed by a capture.** Every selector the extension
  reads out of Gemini's page is now declared in
  `cloudflare-worker/tests/helpers/dom-signal.mjs` with its expected value in
  each state and the observation that justifies it. `checkDomSignals()` fails
  the build when a signal has no recorded capture, names a fixture that does
  not exist, or claims something its capture contradicts. Captures live in
  `cloudflare-worker/tests/fixtures/` as structural attributes only — no text,
  no tokens, nothing GUARDRAILS G1.2.1 forbids persisting.

  This is the enforced form of a rule that was learned twice the hard way. In
  KAN-192 a test asserted a manifest string while the JavaScript beside it was
  older. In KAN-197/198 a test asserted that `has-thoughts` meant "currently
  processing" — it means "has a thinking section", permanently — and shipped a
  bridge that could not answer at all. Both were correct as data and wrong as
  evidence, and nothing in the repo required the evidence to exist.
- **A regression test for the delegation tooling's isolation gate.**
  `agy-run --mode worktree` claimed the caller's repo was untouched; on
  2026-09-29 that claim was false, because a packet with a hardcoded
  `cd /Users/…/repo` sent an isolated delegate out of its worktree and the run
  still reported success. The gate now snapshots the repo with
  `git status --porcelain` before the agent starts, exits 71 on a breach, and
  includes untracked files. The test pins all three.

### Fixed
- **The handoff document misstated the tree.** Its header named `cd205ea` and
  459 tests where the truth was `561a126` and 492, and described the extension
  as 4.7.11 while the worker was still the deployed version. A document that
  lies about the tree is the same defect one level up.

### Notes
- Not deployed. The worker still runs 4.7.11; `wrangler deploy` is left to the
  operator. This change is extension-side and test-side only.

## [4.7.14] - 2026-09-29

### Fixed
- **The generating signal read two class names that never change.**
  4.7.13 keyed `isGenerating()` on `processing-state-visible` and
  `has-thoughts`, sampled once from a response that was still streaming. They
  are permanent: the same response measured after settling still carried
  `class="model-response-text has-thoughts processing-state-visible"`, beside
  a `response-footer … has-thoughts complete`. So the signal stayed true after
  the answer was done, `handleCollectAnswer` burned its full 120s budget, and
  every call failed with `collect_answer_timeout` on an answer that had been
  finished for a minute.

  The signal is `aria-busy`, measured by sampling the DOM across one whole
  generation: present at 1242px and again at 3508px, absent once settled.
  It is the only candidate that differs between the two observed states.

### Notes
- The tests for this were written from the assumption rather than from a
  capture, which is why they passed against code that wedged production. The
  fixtures are now the measured before/after DOM, and re-introducing the
  4.7.13 check fails four of them.
- Not deployed. The worker still runs 4.7.11; `wrangler deploy` is left to the
  operator.

## [4.7.13] - 2026-09-29

### Fixed
- **The bridge judged a half-written answer.** `generatingSignal()` checked a
  spinner, a stop button and a lottie clipPath. None of them exist on this
  build: the response instead carries
  `processing-state-visible` and `has-thoughts`, and neither was looked for. So
  `isGenerating()` returned false mid-generation, `handleCollectAnswer` stopped
  waiting, and the worker ran its grounding check on a partial answer.
  Measured: `COLLECT_ANSWER` reported `chars=37` and the answer was judged
  `no_citations_in_response`, while the same response was 1267px tall and
  complete moments later. The class check is scoped to the newest response,
  because a finished response keeps `has-thoughts` permanently.
- **Grounding settled after 1.2 seconds of stillness.** A gap between two
  bursts of a long Thai answer looked identical to a finished one, and
  citations stream in after the text. The settle window is now 4 seconds, the
  counter is suspended while the response is still generating, and a timeout
  that expires mid-generation reports `timeout_while_generating` rather than
  claiming citations were absent.

Both were the same defect at two layers, and the second is the one KAN-182
already warned about: an unreadable answer reported as an ungrounded one.

### Notes
- Not deployed. The worker still runs 4.7.11; `wrangler deploy` is left to the
  operator.

## [4.7.12] - 2026-09-29

### Added
- **Sanitized payload strings carry a shape class.** A sanitized structure
  recorded every string as `{type, length}`, and a length cannot be
  attributed: two different values can share one, so "this field changed
  size" is equally consistent with a notebook reference appearing, vanishing,
  or never having been there. That is what left the replay-path question
  unanswerable — KAN-195's two samples differed in exactly one field's length
  and nothing else. Each string now also carries `cls` from a closed set of
  protocol shapes (`notebook_ref`, `url`, `uuid`, `build_label`, `json_blob`,
  `opaque`), so the question becomes "does any field carry a notebook
  reference" — one bit per field, decided by the protocol rather than by the
  person typing. No prefix, substring, hash or first-N of any string is
  recorded, so a prompt lands in `opaque` with nothing kept (GUARDRAILS
  G1.2.1).
- **A payload probe that ships switched off.** It reads the sanitized
  structures above and writes them to the page console — the only sink that
  cannot persist anything. Toggled at runtime rather than hand-inserted, so a
  later capture costs one message instead of a commit, a build and a reload,
  and a debugging aid cannot be left enabled in a build that goes out.

### Fixed
- **The canary that checks the guardrail did not detect a leak.** Its first
  version asserted that the whole prompt and the tokens `lesson4` and
  `FORTUNE` were absent from the sanitized output — all three sit past the
  eighth character, so `prefix: val.slice(0, 8)` passed it. The canary now
  sweeps every 6-character window of the prompt and fails under that
  mutation. A leak detector that only looks where the leak is not is the same
  defect this project has now met at four different layers.

### Notes
- The version line is unified: worker, npm package, lockfile and extension
  manifest ship as one version, and `version-consistency.test.mjs` makes a
  partial bump a hard failure rather than a production surprise.
- Not deployed. The worker still runs 4.7.11; `wrangler deploy` is left to the
  operator. The change is extension-side only, so the probe works without it.

## [4.7.11] - 2026-09-29

### Fixed
- **A dead extension context looked healthy.** Reloading the extension at
  `chrome://extensions` invalidates every live content script:
  `chrome.runtime.id` becomes undefined and later `chrome.*` calls throw. The
  page keeps the old script and it cannot re-inject itself, so the only
  remedy is a tab reload — but nothing said so. Observed live: the worker
  reported `extension_status: DISCONNECTED` while the on-page indicator still
  read "Bridge: Online" in healthy green, because the stale script never
  receives a disconnect notice and simply renders the last state it was told.
  Anyone checking the UI concluded the bridge was fine. Meanwhile
  `initCentralCoordinator` retried `chrome.runtime.connect()` every second
  against a runtime that no longer existed, emitting an endless stream of
  identical "Attempting reconnect..." warnings that all said the same
  unactionable thing.

  All four reconnect sites now check `chrome.runtime.id` first. A missing
  runtime calls `markExtensionStale()`, which puts the indicator into a
  distinct `stale` state — purple `#a855f7`, no pulse — reading "Reload this
  tab (extension reloaded)". The remedy names the tab, not the extension,
  because reloading the extension is what caused the state. The notice is
  latched so reconnects cannot flicker it, and its indicator write is wrapped
  in try/catch so a cosmetic failure cannot break recovery.

  `tests/extension-stale-context.test.mjs` pins the detection on every retry
  site, the distinct colour, the actionable text, the latch, and the
  declaration order of the flag (a `let` read from a path that can run during
  init would be a temporal-dead-zone crash).

## [4.7.10] - 2026-09-29

### Fixed
- **Auto-focus could not report its own failure.** A grounded call needs the
  Gemini tab in the foreground; the extension now asks the background script
  to focus it (`REQUEST_TAB_FOCUS` → `chrome.tabs.update` +
  `chrome.windows.update`) and polls `document.visibilityState` for up to 2s
  instead of sleeping a flat 200ms. The first version polled and then
  *discarded the boolean*, which made the wait cosmetic: a tab that never came
  forward still ran the full attach/typing path and failed much later, inside
  the module, as `tab_not_visible` — the identical reason a genuinely hidden
  tab produces. The log then read as a UI or selector problem when the real
  cause was "Chrome never focused the tab", and the two are indistinguishable
  afterwards. Both handlers now bail on a timeout with the distinct reason
  `tab_never_visible` and `step: "visibility"`, so a failed focus is legible
  instead of masquerading as a UI failure. `waitForTabVisible` also treats a
  document with no `visibilityState` as visible, matching the modules'
  `isTabVisible()` rule — failing closed there would wedge every test rig and
  embedder lacking the Page Visibility API.

## [4.7.9] - 2026-09-29

### Fixed
- **The collector could never see the answer it was waiting for.** Live run 6: `horo_consult` returned 1/1 `answered` with `last_grounding_status = grounded` on the first call, but the second consecutive call failed with `no_answer_rendered, responses on screen=3` — while the DOM showed a third `user-query` carrying the notebook, so the prompt had in fact been sent. The baseline was sampled in `handleCollectAnswer`, i.e. when the worker asked for the answer, and Gemini can render a response *before* that request arrives; the collector was therefore already looking at the answer it was waiting for and correctly, but uselessly, concluding that nothing newer existed. The count is now sampled in `typeAndSend` **before** the send button is clicked and carried through `TYPE_PROMPT_RESULT` → `collectTypedAnswer` → `COLLECT_ANSWER` as `responsesBefore`, so the baseline predates the request it attributes. This is the same lesson as 4.7.8 — a measurement taken too late is not evidence — and the acceptance condition for KAN-182 is two *consecutive* grounded calls, which is exactly the case the old ordering could not express.

## [4.7.8] - 2026-09-29

### Fixed
- **A correctly grounded answer was reported as ungrounded.** Live run 5 on 4.7.7 was the first to reach the end of the chain: the notebook attached, the typed prompt landed, a new conversation was created (`/app` → `/app/c717b39dd73233a4`), a `user-query` rendered, and the answer streamed. The verdict was still `no_citations_in_response` — but the settled response carried **nine** `source-inline-chip` elements citing *"PDF: FORTUNE_original_lesson4.pdf"*, a file from the Horo notebook. A grounded answer streams its citations in *after* its text, and the check read once, immediately, so it judged a still-streaming response. `handleVerifyGrounding` now polls until the citations appear and only concludes "ungrounded" once three consecutive samples show the newest response unchanged — an unchanged response is a finished one, so that verdict is a real answer rather than a guess. The worker's budget was raised to 35s to cover the wait.

## [4.7.7] - 2026-09-29

### Fixed
- **A notebook-grounded answer was being produced by a path that cannot ground.** Live run 4 captured the request on the wire: the `StreamGenerate` POST went out as `resourceType: "fetch"` (the page's own calls are `xhr`) with no `f.sid`/`hl=th`, and the decoded body was `f.req=[null,"[[\"Act as ซินแส AI …\",0,null,…],…]"]` — the bare prompt, **no `notebook://…/sources/…` reference at all**. So the replay path had started working, was returning a perfectly good answer, and was rendering nothing in the page. Two consequences: the answer was written from general knowledge by construction, and the grounding check had no `model-response` to read, which is why 4.7.6 reported `no_response_rendered` with zero queries and zero responses on screen. Replay is not a neutral fallback — it cannot carry a notebook attachment, because the attachment only exists in the request the **page** builds. `executeThroughExtension` now takes `requireGrounding`, set for a default-scoped `horo_consult`, and skips replay entirely in favour of the typed path. This is the first version where the notebook attach and the answer come from the same request.

## [4.7.6] - 2026-09-29

### Fixed
- **The prompt write was reported as successful on a value Angular had already reverted** (live run 3 on 4.7.5 showed the MAIN-world relay being reached, yet the editor returning to `ql-blank`): the relay read the editor back *immediately* after `quill.setText`, which is a transient value, and treated it as proof. It now waits for a change-detection turn and reports the **settled** state, and settledness is read from the `ql-blank` class rather than the text — that class is precisely what Angular restores, so it distinguishes "landed and I looked too early" from "rejected outright". Retries are bounded and only re-apply while the editor is still blank.
- **The write is now pushed into Angular's model, which is what makes it persist**: `quill.setText(t, "user")` does emit Quill's `text-change`, but from a MAIN-world script it runs outside `NgZone`, so the `ControlValueAccessor`'s `onChange` never reaches the `FormControl`. The form value stays `""` and the next change-detection pass calls `writeValue("")`, resetting the editor. `syncAngularModel()` uses the Angular debug API (`ng.getComponent` / `ng.getDirectives` / `ng.applyChanges`, trying `formControl`/`control`/`model`/`value`) to set the bound value, and an `input` event is dispatched first so Zone.js has a native event to hook. Both are best-effort: the result reports `ngSynced` so a live run says whether the debug API was reachable, which is what distinguishes "retry longer" from "only a trusted event can get through".

### Not unit tested
The MAIN-world typing logic in `injected.js` is a side-effecting IIFE (it installs
a `message` listener and patches `fetch` on load) and cannot be `require`d in the
Node test environment — `ReferenceError: window is not defined`. The 4.7.6 settle
and Angular-sync behaviour is therefore **verified by live run only**, not by
unit tests. Writing tests for it needs a `window`/`document` harness, which is
follow-up work; do not assume it is covered.

## [4.7.5] - 2026-09-29

### Fixed
- **The prompt could not be typed at all, for an architectural reason** (the root cause behind 4.7.3's failed live run): content scripts run in Chrome's ISOLATED world, which shares the DOM with the page but **not JavaScript expandos**. The `__quill` property Angular sets on `rich-textarea` lives in the page's own context, so `getQuill()` in the content script returns `null` no matter how the lookup is written — and every isolated-world write (`textContent`, a synthetic `InputEvent`, `execCommand`) is reconciled away by Angular, leaving the editor `ql-blank` with no prompt ever sent. Typing is now relayed to `injected.js`, which already runs in the MAIN world via `world: "MAIN"`, over the existing `postMessage` bridge (`TYPE_PROMPT_INTO_EDITOR` → `PROMPT_TYPED`). It drives `quill.setText(text, "user")` from the world that owns the instance, and replies with the editor's actual text so the isolated side verifies rather than assumes. The DOM writes remain as a last resort for a page where the MAIN world never answers, which now times out after 5s and falls back instead of hanging. No `chrome.debugger` permission is required.
- **A missing `InputEvent` could discard a write that had already landed**: the fallback wrapped the `textContent` assignment and the event dispatch in one `try`, so an environment without `InputEvent` reported failure for a write that had in fact succeeded. They are guarded separately now, and the mandatory read-back decides.

## [4.7.4] - 2026-09-29

### Fixed
- **An answer could not be attributed to the request that asked for it** (surfaced by running 4.7.3 live, where `collectTypedAnswer` reported success while the `user-query` count never moved): `waitForResponseChange()` compared the newest response's *text* against the text captured at the start. A conversation keeps every earlier reply, so when the prompt never reached Gemini the newest response was still the previous turn's answer — stable, non-placeholder, and different from the start snapshot if anything re-rendered mid-wait. Text cannot tell "the answer to my question" from "an answer that happens to be on screen"; the response **count** can. The wait now takes a `minResponses` floor and requires a strictly newer response, and `handleCollectAnswer` re-checks it after the streaming settle. `retryViaUi` passes `minResponses: 0` because regenerate re-renders in place rather than appending. The failing reason is now `no_new_response_rendered` and reports how many responses the page held, instead of the misleading `no_citations_in_response` from grading a response the caller never asked for.

## [4.7.3] - 2026-09-29

### Fixed
- **The typed prompt was never actually typed** (found by running 4.7.2 live): `setPromptText()` required a `__quill` JS property on `rich-textarea`, which was not reachable on the live tab. With no Quill instance the old fallback assigned `textContent` and dispatched a synthetic `InputEvent`, and Angular reconciled the editor straight back to `ql-blank` — the prompt was never sent, and combined with the 4.7.2 stale-answer bug the tool reported the previous turn's text. `getQuill()` now also checks the inner `.ql-editor` and is treated as best-effort; the primary path is `execCommand('insertText')` on the focused editor, which emits the real `beforeinput`/`input` pair Quill's own listeners react to. Verified live: real input events clear `ql-blank`, surface the send button, and submit — a 9th `user-query` appeared. No `chrome.debugger` permission needed, and `textContent` alone is still never the primary path (it doubles the text when it works at all).

## [4.7.2] - 2026-09-29

### Fixed
- **Stale answers were returned as if they were this call's own** (surfaced by the 4.7.1 grounding check on its first live run): `waitForResponseChange()` resolved `{changed:false, text:<the last model-response>}` on timeout, and `executeThroughExtension` adopted that text unconditionally — `text = collected.text`, with the `ok` flag ignored. When a typed prompt failed to land, `horo_consult` answered with the **previous** turn's text and then failed grounding on it, reporting `no_citations_in_response` and pointing the operator at the notebook when no question had been asked at all. Two different faults, one misleading symptom. A timeout now returns empty text, and an unreadable answer raises its own error instead of being graded as an ungrounded one.

## [4.7.1] - 2026-09-29

### Fixed
- **`horo_consult` reported ungrounded answers as grounded (the notebook attaches per MESSAGE, not per conversation)**: `notebook-attach.js` short-circuited the attach whenever a chip was already in the input area and returned `{ok:true, alreadyAttached:true}`. Grounding is consumed per message — measured from real `StreamGenerate` payloads on 2026-09-29, a prompt sent after the chip was spent carries **no** `notebook://…/sources/…` reference at all — so from the second `horo_consult` call onward the answer was written from general knowledge while the tool reported it as grounded, and nothing in the returned text let the caller tell. A leftover chip is now cleared and the full attach flow always runs, guaranteeing exactly one fresh reference per submitted prompt. Re-attaching does not stack: the payload carries exactly one set of references.
- **Grounding is now verified, not assumed**: `attached` and `verified` are separate claims. `notebookGrounding.verified` is decided *after* the answer streams, from the citations in that answer, and an unverified answer returns JSON-RPC `-32000` rather than a plausible-looking ungrounded reading. `check_bridge_health.notebook` reports `last_grounding_status` separately from `last_attach_status`, because an attach can succeed while every answer that follows is ungrounded — reading only the attach status called that healthy.

### Added
- **`VERIFY_GROUNDING` / `GROUNDING_RESULT` protocol messages** and `NotebookAttach.readGroundingEvidence()`, which reads citations from the **newest** `model-response` only. Scoped deliberately: `source-inline-chip` elements from earlier replies stay in the DOM for the life of the conversation, so a document-wide scan finds citations belonging to a grounded answer several turns back. Confirmed against the live DOM — a 7-response conversation held 2 chips in the 5th response while the newest 2 responses had none.
- **Prompt typing fallback (`prompt-typing.js`, KAN-182)**: asks through Gemini's own input box when the replay path produces no chunk. The bridge's assembled `StreamGenerate` payload is refused by a schema change on Google's side, so the question never leaves the browser (0 `user-query` / 0 `model-response` rendered, 60s timeout). Text is set through `quill.setText(text, "user")` — `'api'` renders the text but never surfaces the send button, and `textContent` lands the prompt twice. No `chrome.debugger` permission is required.
- **`TYPE_PROMPT` / `COLLECT_ANSWER` protocol messages** so the worker can read an answer back out of the page after a typed submit.

## [4.4.3] - 2026-09-26

### Fixed
- **`decodeChunk` truncation of LMDX / `lmdx_content` answers**: the decoder took the **last** `wrb.fr` text in a buffer while the caller **replaces** its accumulator (Gemini re-sends the cumulative answer). Gemini appends a private conversation link (`https://googleusercontent.com/lmdx_content/...`) and can emit LMDX UI-component entries in their own `wrb.fr`, so a finished answer was overwritten by that trailing fragment — long SDLC output (`orchestrate_sdlc_plan`) came back link-only, truncated or empty. The decoder now keeps the longest coherent text, and `executeThroughExtension` only adopts an update that is at least as complete as what it already holds.
- **`decodeChunk` text-slot shapes**: the positional slot (`innerData[4][0][1]`) is handled whether it is a string, an array of segments, or a structured LMDX block; previously a plain string degraded to its **first character** and structured blocks were dropped silently.
- **`decodeChunk` state loss on malformed payloads**: a `JSON.parse` failure inside one `wrb.fr` no longer discards the rest of the line (which also carried `conversationId` / `responseId`).
- **Private link leakage**: the trailing `googleusercontent.com/lmdx_content/...` link is stripped from answers before they reach API/MCP clients.
- **Blank-success tool results**: a decoded-empty model answer now returns JSON-RPC error `-32000` (`Empty model response …`) and, when configured, falls back to GCP Gemini — instead of a successful result with empty `content`. A link-only answer counts as empty.
- **SDLC tool argument contract**: the docs advertised `problem_description` for all four SDLC tools while the schemas used per-tool names, so `orchestrate_sdlc_plan` prompted `Goal: undefined`. All four tools now accept the documented alias (`orchestrate_sdlc_plan`: `feature_or_goal` | `problem_description`; `code_review_and_debug`: `code_snippet`; `evaluate_tech_tradeoffs`: `decision_context`) and return `-32602` with the missing argument name instead of calling Gemini with `undefined`. README/HANDOFF parameter tables corrected.
- **`/health` counters were dead**: `healthState` is a derived getter that rebuilds an object per read, so every `this.healthState.consecutiveErrors++` / `lastError = …` write mutated a throwaway copy — production always reported `consecutive_errors: 0, last_error: null` and the `check_bridge_health` "degraded" threshold could never fire. All writes now go through `recordHealthError()` / `recordHealthSuccess()`.
- **Version drift**: `/health`, MCP `serverInfo` and `ping` reported a hardcoded `4.3.4` while `package.json` said `4.3.7` and the extension manifest said `4.4.3`. All version strings now read a single `WORKER_VERSION` constant, and `package.json` / `package-lock.json` / `manifest.json` are pinned to the same release line.

### Security
- `wrangler.staging.toml` no longer ships a plain-var `BRIDGE_SECRET` (was the guessable `staging-token-change-me`); the worker now fails closed until the secret is set with `wrangler secret put`.

### Added
- `tests/decode-chunk.test.mjs` (9 cases: cumulative text, trailing `lmdx_content` link, string/array/structured text slots, malformed-payload state recovery, non-JSON lines).
- `tests/sdlc-tool-args.test.mjs` (6 cases: documented alias, canonical argument, missing-argument errors, empty/link-only answers, trimmed result).
- `tests/health-metrics.test.mjs` (2 cases: counters persist across reads and surface in `/health` + `check_bridge_health`).
- `tests/version-consistency.test.mjs` (4 cases: `WORKER_VERSION` ↔ `package.json` ↔ `package-lock.json` ↔ extension manifest, and no hardcoded version literals left).

### Fixed (Chrome extension runtime)
- **Refresh-teardown error spam**: Page refresh no longer logs spurious `[Bridge] WebSocket Error` and `[Bridge] Disconnected (code: 1006)` warnings. Added `isRefreshing` flag via `beforeunload`/`pagehide` detection to suppress expected WebSocket teardown noise.
- **EvidenceRegistry init race**: `saveToStorage()` now defers writes until `init()` completes via `initialized` guard, eliminating the race between async `registry.init()` and SESSION_STATE evidence recording that triggered `Context invalidated during save` on refresh.
- **Context-invalidation classification**: `saveToStorage()` now classifies context-invalidation errors as PERMANENT (orphaned — retry can never succeed after an extension reload/update, only a tab reload helps) instead of silently skipping. Orphaned saves stay fully silent (no `Context invalidated during save` warning); transient failures (timeout/quota) set `_hasPendingWrites` and are retried on the next save cycle, also silently. `init()` restores the in-memory snapshot on orphaned load with no warning and never flushes. A one-time `onOrphaned` hook lets content.js surface a single `Bridge: Reload tab (extension updated)` pill hint via the deduping indicator.
- **CSP manifest-src noise**: the Gemini page's own `manifest-src 'none'` policy (Google fetches its internal manifest against its own policy) no longer logs `[Gemini Bridge] CSP manifest-src violation … [object SecurityPolicyViolationEvent]`. Site-side violations are ignored silently; only extension-attributable violations are logged with structured fields. Removed the no-op `event.preventDefault()` (`SecurityPolicyViolationEvent` is not cancelable).
- **New tests**: Added 4 test cases covering orphaned-save silence + no-retry, timeout TRANSIENT classification, orphaned-init snapshot restore, and one-time `onOrphaned` hook firing.

### Added
- Refresh/teardown detection event listeners in content.js (`beforeunload`, `pagehide`, `pageshow`).
- `_hasPendingWrites` tracking and flush mechanism in EvidenceRegistry.

### KAN-126
- **horo_consult scope isolation (fixed)**: `horo_consult` intentionally defaults to the HoroConsultant knowledge Notebook (`notebook:b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0`) so BaZi answers stay grounded in that notebook. The scope switch was never undone, so a single unscoped `horo_consult` call left the session (and the extension tab) pinned to the Notebook, and every following unscoped tool call silently inherited it. Tool execution is now wrapped in `runInPreparedScope()` with a `finally` scope restore, covering the success, error, GCP-fallback and extension-disconnected paths; `switchedScope` is derived from session state so a fail-closed `applyScope` also restores. Tool arguments are per-call, not a session mutation — an explicitly passed `scope` is now also restored afterwards.
- **Scope transparency (added)**: every successful tool result carries `bridgeScope: { used, active, restored }` so MCP clients can see which scope actually served the answer.
- **Default scope documentation (changed)**: all tool `scope` descriptions now state the default explicitly — `https://gemini.google.com/app` for the four SDLC tools (they inherit the session scope, which defaults to App), and the HoroConsultant Notebook + restore behaviour for `horo_consult`.
- **New tests**: 5 regression tests covering default-switch-then-restore, explicit-scope-then-restore, no-op when the requested scope equals the current one, restore on execution failure, and that unscoped SDLC tools never trigger a scope switch.

### KAN-123
- Structured cross-functional review (KAN-122) applied: Option B selected after Red Team, Blue Team, Worker Specialist, and Research perspectives.

## [4.3.7] - 2026-09-23

### Fixed
- **EvidenceRegistry async race condition**: `init()` no longer regenerates session epoch or clears records that were auto-verified during the async storage wait. Snapshot-and-preserve pattern ensures `verified` records with valid `mappingRevision` survive across the `await` boundary.
- **Extension packaging**: Added `scripts/zip-extension.py` and CI job (`package-extension`) to produce versioned, installable extension zips automatically. Previously, incorrect zip structure (including `node_modules/` or missing `manifest.json`) made Chrome refuse to load the extension.

### Automation
- CI: New `package-extension` job zips `extension-cloudflare/`, validates `manifest.json`, and uploads as `gemini-bridge-extension` artifact (90-day retention).
- Git: `release/` added to `.gitignore` (build artifact, not committed).
- Local build: `python3 scripts/zip-extension.py` produces `release/gemini-bridge-v{X.Y.Z}.zip`.

## [4.3.6] - 2026-09-19

### Added
- Manifest version bump for extension reload.

## [4.3.4] - 2026-09-18

### Changed
- Worker stability patch: Exclusive SW channel & rogue socket elimination.

## [4.2.0] - 2026-09-12

### Changed
- Initial Cloudflare Workers deployment.
