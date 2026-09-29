// Regression tests for Gemini refusal detection and the native-retry helper.
//
// Background: Gemini returns refusals as an ordinary `result` inside a 200 MCP
// response. The old measurement script only looked for session/transport
// wording, so every refusal scored as a PASS — the bridge reported success
// while Gemini had answered "I encountered an error doing what you asked."
// A parallel production run showed the same failure for "What is the capital
// of France?", proving the replay payload itself (not the prompt) is at fault.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyGeminiReply,
  isRetryWorthwhile,
  RETRY_BACKOFF_MS,
  REFUSAL_KIND
} from '../src/gemini-refusal.js';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { buildToolPrompt } from '../src/prompt-templates.js';

const require = createRequire(import.meta.url);
const NativeRecovery = require('../../extension-cloudflare/native-recovery.js');
const NotebookAttach = require('../../extension-cloudflare/notebook-attach.js');

// ── Notebook attach: selectors verified against the live Gemini DOM ──────────
//
// Every selector here was read out of a real, authenticated
// gemini.google.com tab (2026-09-29, boq-gemini-web-uiserver) by driving the
// actual menu. They are NOT copied from a DOM sample: the flow was clicked
// through end to end and the DOM re-read after each step. That distinction
// matters because the Lottie selector KAN-176 "verified" against a DOM sample
// matched nothing in production, and every wait silently degraded.

test('the attach flow uses only localization-proof selectors', () => {
  const S = NotebookAttach.SELECTORS;
  // The UI is in Thai here and English elsewhere. A selector that depends on
  // a visible label would work in exactly one locale and fail everywhere else.
  const localized = ['อัปโหลด', 'การอัปโหลดเพิ่มเติม', 'เพิ่ม Notebook', 'Notebook', 'เครื่องมือ'];
  for (const [name, sel] of Object.entries(S)) {
    for (const word of localized) {
      assert.ok(
        !String(sel).includes(word),
        `SELECTORS.${name} ("${sel}") must not match on the localized label "${word}"`
      );
    }
  }
  // The two steps that have no test-id at all are keyed by class / icon name.
  assert.equal(S.plusButton, 'input-area-v2 mat-icon[data-mat-icon-name="plus"]');
  assert.equal(S.moreUploadsButton, 'button.more-upload-button[cdkoverlayorigin]');
  // "more_horiz" is shared with the "เครื่องมือเพิ่มเติม" item, so the class is
  // the only thing that discriminates the more-uploads submenu.
  assert.ok(!S.moreUploadsButton.includes('more_horiz'));
  assert.equal(S.notebooksButton, '[data-test-id="notebooks-import-button"]');
  assert.equal(S.addButton, '[data-test-id="add-button"]');
  assert.equal(S.attachedChip, 'input-area-v2 uploader-file-preview');
});

test('a HIDDEN tab is refused up front, not reported as a selector failure', () => {
  // The bug this guards: a CDK overlay pane IS created and the "+" trigger
  // DOES flip to aria-expanded="true" on a hidden tab, but Angular never
  // populates the panel. Every child selector then matches nothing and the
  // flow dies at "more_uploads", which reads as a broken selector when the
  // real cause is simply that nobody was looking at the tab.
  assert.equal(NotebookAttach.isTabVisible({ hidden: true }), false);
  assert.equal(NotebookAttach.isTabVisible({ hidden: false }), true);
  // A document with no Page Visibility API is treated as visible rather than
  // failing closed, or every mock-based test would break.
  assert.equal(NotebookAttach.isTabVisible({}), true);
});

test('attachNotebook returns tab_not_visible without clicking anything', async () => {
  const doc = { hidden: true, querySelector: () => null, querySelectorAll: () => [] };
  const out = await NotebookAttach.attachNotebook({
    notebookName: 'Horo', doc, log: () => {}, sleep: async () => {}, setT: () => {}
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'tab_not_visible');
  assert.equal(out.step, 'visibility');
});

test('an already-attached notebook makes the flow a no-op (idempotent)', async () => {
  const chip = { innerText: 'Horo', textContent: 'Horo' };
  const doc = {
    hidden: false,
    querySelectorAll: (sel) => (sel === NotebookAttach.SELECTORS.attachedChip ? [chip] : []),
    querySelector: () => null
  };
  const out = await NotebookAttach.attachNotebook({
    notebookName: 'Horo', doc, log: () => {}, sleep: async () => {}, setT: () => {}
  });
  assert.equal(out.ok, true);
  assert.equal(out.alreadyAttached, true);
  assert.deepEqual(out.attached, ['Horo']);
});

test('the notebook row is matched by name, never by list position', () => {
  // This account has six notebooks and the target is not always first, so a
  // positional match would silently attach the wrong knowledge base.
  const TITLES = [
    'Horo',
    'claude-code-best-practice',
    'Spring Security Architecture and JPA Performance Optimization Strategies',
    'Bangkok Bank Java Technical Lead Interview Research Dossier',
    'Spiritual Guidance for Career Success and Ancestral Alignment',
    'Citta AI Notebook'
  ];
  const doc = {
    querySelectorAll: (sel) => (sel === NotebookAttach.SELECTORS.notebookTitle
      ? TITLES.map((t) => ({ textContent: t, closest: () => ({ __row: t }) }))
      : [])
  };
  assert.equal(NotebookAttach.findNotebookRow(doc, 'Horo').__row, 'Horo');
  // Case and surrounding whitespace must not defeat it.
  assert.equal(NotebookAttach.findNotebookRow(doc, '  horo ').__row, 'Horo');
  // An unknown notebook must return null rather than falling back to index 0,
  // which would attach the wrong notebook and report success.
  assert.equal(NotebookAttach.findNotebookRow(doc, 'Nonexistent'), null);
  assert.equal(NotebookAttach.findNotebookRow(doc, ''), null);
});

test('openPlusMenu does not click an already-open menu, which would close it', () => {
  // The "+" trigger is a toggle. A blind click breaks any retry after a
  // partially-completed attempt, and the failure only surfaces several steps
  // later as a missing menu item.
  let state = { expanded: false, clicks: 0 };
  const btn = {
    getAttribute: (a) => (a === 'aria-expanded' ? String(state.expanded) : null),
    click: () => { state.clicks++; state.expanded = !state.expanded; }
  };
  // findPlusButton resolves the mat-icon to its wrapping <button> first.
  const icon = { closest: (sel) => (sel === 'button' ? btn : null) };
  const doc = { querySelector: () => icon };

  assert.equal(NotebookAttach.openPlusMenu(doc), true);
  assert.equal(state.expanded, true, 'a closed menu must be opened');
  assert.equal(state.clicks, 1);

  assert.equal(NotebookAttach.openPlusMenu(doc), false);
  assert.equal(state.expanded, true, 'an open menu must be left alone, not toggled shut');
  assert.equal(state.clicks, 1);

  assert.equal(NotebookAttach.openPlusMenu({ querySelector: () => null }), false);
});


// ── Prompt shape: prose, not a spec sheet ─────────────────────────────────
//
// The old templates were field labels ("[Role: ...]", "Language: ...",
// "Error Log: ...", "Task: ..."). A live A/B on production showed the replay
// transport fails identically for the labelled template and for "What is the
// capital of France?", so format was never the outage cause — but
// "Prompt Design at Scale" (arXiv 2607.19257) finds that refusal, not wrong
// recall, is what rises under structured formats. Prose is the better default
// for a prompt a human would actually type.

test('no template emits the old [Role: ...] label block', () => {
  const cases = [
    ['sdlc_solution_architect', { problem_description: 'build a thing' }],
    ['orchestrate_sdlc_plan', { feature_or_goal: 'ship a login' }],
    ['code_review_and_debug', { code_snippet: 'x = 1' }],
    ['evaluate_tech_tradeoffs', { decision_context: 'pick a queue', options: 'A vs B' }],
    ['horo_consult', { query: 'what is a day master' }]
  ];
  for (const [name, args] of cases) {
    const prompt = buildToolPrompt(name, args);
    assert.doesNotMatch(prompt, /\[Role:/, name);
    assert.doesNotMatch(prompt, /\nLanguage:/, name);
    assert.doesNotMatch(prompt, /\nError Log:/, name);
    assert.doesNotMatch(prompt, /\nTask:/, name);
    assert.doesNotMatch(prompt, /\nGoal:/, name);
  }
});

test('every template reads as sentences a person would write', () => {
  const prompt = buildToolPrompt('code_review_and_debug', {
    code_snippet: 'x = 1', error_log: 'boom', language: 'javascript'
  });
  assert.match(prompt, /^Act as an expert code reviewer and debugger\./);
  assert.match(prompt, /Can you find the root cause/);
  // Ends with the code, and reads as one flowing paragraph of prose.
  assert.ok(prompt.indexOf('Can you find') < prompt.indexOf('```'));
});

test('a missing optional argument never leaks the word "undefined"', () => {
  const cases = [
    ['sdlc_solution_architect', { problem_description: 'x' }],
    ['orchestrate_sdlc_plan', { feature_or_goal: 'x' }],
    ['code_review_and_debug', { code_snippet: 'x' }],
    ['evaluate_tech_tradeoffs', { decision_context: 'x' }],
    ['horo_consult', { query: 'x' }]
  ];
  for (const [name, args] of cases) {
    assert.doesNotMatch(buildToolPrompt(name, args), /undefined/i, name);
  }
});

test('code indentation and newlines survive the rewrite', () => {
  // A whitespace-collapsing join would silently reformat the caller's code
  // before Gemini ever sees it — the snippet's structure is the whole point.
  const code = 'function average(list) {\n  let sum = 0;\n  return sum / list.length;\n}';
  const prompt = buildToolPrompt('code_review_and_debug', { code_snippet: code, language: 'javascript' });
  assert.ok(prompt.includes(code), 'the snippet must appear byte-for-byte');
  assert.ok(prompt.includes('\n  let sum = 0;'), 'indentation must be preserved');
});

test('an already-fenced snippet is not double-fenced', () => {
  const prompt = buildToolPrompt('code_review_and_debug', { code_snippet: '```js\nlet a = 1;\n```' });
  const fences = (prompt.match(/```/g) || []).length;
  assert.equal(fences, 2, 'exactly one fence pair');
});

test('a language of "None"/absent does not produce an empty fence label', () => {
  const prompt = buildToolPrompt('code_review_and_debug', { code_snippet: 'x = 1', error_log: 'None' });
  assert.doesNotMatch(prompt, /```\n\n/);
  assert.doesNotMatch(prompt, /What I see is/, '"None" is not an error worth reporting');
});


// ── The exact strings observed in production on v4.4.3 ────────────────────
const OBSERVED = [
  ['I encountered an error doing what you asked. Could you try again?', REFUSAL_KIND.UPSTREAM_ERROR],
  ["I seem to be encountering an error. Can I try something else for you?", REFUSAL_KIND.UPSTREAM_ERROR],
  ["I'm having a hard time fulfilling your request. Can I help you with something else instead?", REFUSAL_KIND.SOFT_REFUSAL],
];

test('every refusal actually seen in production is classified as a failure', () => {
  for (const [text, expected] of OBSERVED) {
    assert.equal(classifyGeminiReply(text).kind, expected, text.slice(0, 50));
  }
});

test('a refusal is never ANSWERED — the defect that made them score as PASS', () => {
  for (const [text] of OBSERVED) {
    assert.notEqual(classifyGeminiReply(text).kind, REFUSAL_KIND.ANSWERED);
  }
});

test('a real answer is not misclassified', () => {
  const real = [
    'Use a Cloudflare Worker in front of KV. Here is the routing table...',
    'Paris.',
    'As an AI language model, I do not have personal opinions, but here are the facts...',
  ];
  for (const text of real) {
    assert.equal(classifyGeminiReply(text).kind, REFUSAL_KIND.ANSWERED, text.slice(0, 40));
  }
});

test('"As an AI" alone is not a refusal (it appears in usable answers)', () => {
  assert.equal(
    classifyGeminiReply('As an AI, I cannot browse the internet, but KV is a key-value store.').kind,
    REFUSAL_KIND.ANSWERED
  );
});

test('empty text is not treated as a refusal', () => {
  assert.equal(classifyGeminiReply('').kind, REFUSAL_KIND.ANSWERED);
  assert.equal(classifyGeminiReply(null).kind, REFUSAL_KIND.ANSWERED);
});

test('hard refusals are not retried; upstream errors and soft refusals are', () => {
  assert.equal(isRetryWorthwhile(REFUSAL_KIND.UPSTREAM_ERROR), true);
  assert.equal(isRetryWorthwhile(REFUSAL_KIND.SOFT_REFUSAL), true);
  assert.equal(isRetryWorthwhile(REFUSAL_KIND.HARD_REFUSAL), false);
  assert.equal(isRetryWorthwhile(REFUSAL_KIND.ANSWERED), false);
});

test('the retry budget is 3 attempts on a growing backoff', () => {
  assert.equal(RETRY_BACKOFF_MS.length, 3);
  for (let i = 1; i < RETRY_BACKOFF_MS.length; i++) {
    assert.ok(RETRY_BACKOFF_MS[i] > RETRY_BACKOFF_MS[i - 1], 'backoff must grow');
  }
});

// ── Native retry: selector resolution against a Gemini-shaped DOM ─────────

/** Minimal stand-in for the bits of Gemini's DOM the helper touches. */
function makeDoc({ responses = [] }) {
  return {
    querySelectorAll: (sel) => (sel === 'model-response' ? responses : []),
    querySelector: () => null,
  };
}

function makeResponse({ testIdButton = null, hasRefreshIcon = false, text = "I encountered an error doing what you asked. Could you try again?" } = {}) {
  const icon = hasRefreshIcon ? { name: 'refresh' } : null;
  return {
    innerText: text,
    querySelector: (sel) => {
      if (sel === '[data-test-id="regenerate-button"]') return testIdButton;
      if (sel === 'mat-icon[data-mat-icon-name="refresh"]') return icon;
      return null;
    },
  };
}

test('the retry control is found on the NEWEST response, not the first', () => {
  // A conversation holds many responses; re-asking an old one answers the
  // wrong question, so scoping to the last is a correctness requirement.
  const first = makeResponse({ testIdButton: { click() {} } });
  const last = makeResponse({ testIdButton: { click() {} } });
  const found = NativeRecovery.findRetryButton(makeDoc({ responses: [first, last] }));
  assert.equal(found, last.querySelector('[data-test-id="regenerate-button"]'));
});

test('data-test-id is preferred over the icon and over aria-label', () => {
  // aria-label is localized ("ทำซ้ำ" in Thai) and must not be the primary key.
  const button = { click() {} };
  const resp = makeResponse({ testIdButton: button, hasRefreshIcon: true });
  assert.equal(NativeRecovery.findRetryButton(makeDoc({ responses: [resp] })), button);
});

test('retryViaUi reports no_retry_button when Gemini rendered no control', async () => {
  // Gemini omits the retry control for hard errors, so this is a normal path.
  const doc = makeDoc({ responses: [makeResponse({})] });
  const out = await NativeRecovery.retryViaUi({ doc, settleMs: 0, timeoutMs: 50 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no_retry_button');
});

test('retryViaUi resolves with the new text once the response changes', async () => {
  // Gemini writes the new answer only after the click, so the mutation must
  // happen inside the click — setting it beforehand would just be read as the
  // "before" baseline and look like no change.
  const response = makeResponse({ testIdButton: { click() {} } });
  const doc = makeDoc({ responses: [response] });
  response.querySelector('[data-test-id="regenerate-button"]').click = () => {
    response.innerText = 'A Cloudflare Worker in front of KV.';
  };
  const out = await NativeRecovery.retryViaUi({ doc, settleMs: 0, timeoutMs: 500 });
  assert.equal(out.ok, true);
  assert.match(out.text, /Cloudflare Worker/);
});

test('retryViaUi gives up with no_new_response when the answer never changes', async () => {
  const response = makeResponse({ testIdButton: { click() {} } });
  const doc = makeDoc({ responses: [response] });
  const out = await NativeRecovery.retryViaUi({ doc, settleMs: 0, timeoutMs: 60 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no_new_response');
});

test('looksLikeFailure only accepts the refusal/error bodies worth re-asking', () => {
  for (const t of [
    'I encountered an error doing what you asked. Could you try again?',
    "I seem to be encountering an error. Can I try something else for you?",
    "I'm having a hard time fulfilling your request."
  ]) {
    assert.equal(NativeRecovery.looksLikeFailure(t), true, t.slice(0, 40));
  }
  assert.equal(NativeRecovery.looksLikeFailure('Paris is the capital of France.'), false);
  assert.equal(NativeRecovery.looksLikeFailure(''), false);
});

test('retryViaUi refuses to click when the newest answer is already good', async () => {
  // Production race: the worker retries ~2s after the replay, but Gemini may
  // still be showing the PREVIOUS conversation. Clicking then re-asks the wrong
  // question and returns a healthy answer to it. Only click a real failure.
  let clicked = false;
  const response = makeResponse({
    testIdButton: { click() { clicked = true; } },
    text: 'Paris is the capital of France.'
  });
  const doc = makeDoc({ responses: [response] });
  const out = await NativeRecovery.retryViaUi({ doc, settleMs: 0, timeoutMs: 60 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'not_a_failure');
  assert.equal(clicked, false, 'must not touch a healthy answer');
});

test('retryViaUi waits for Gemini to render before deciding', async () => {
  // settleMs exists so the click lands on the failing conversation rather than
  // the previous one; assert the wait actually happens.
  let waited = 0;
  const response = makeResponse({ testIdButton: { click() {} } });
  const doc = makeDoc({ responses: [response] });
  const out = await NativeRecovery.retryViaUi({
    doc,
    settleMs: 1500,
    timeoutMs: 60,
    sleep: async (ms) => { waited += ms; }
  });
  assert.equal(waited, 1500);
  assert.equal(out.ok, false);
});

test("Gemini's 'Gemini บอกว่า' label is a placeholder, not an answer", () => {
  // Observed in production: the native retry returned exactly this 13-char
  // label and the MCP tool scored it as a successful answer.
  assert.equal(NativeRecovery.isPlaceholderOnly('Gemini บอกว่า'), true);
  assert.equal(NativeRecovery.isPlaceholderOnly('  Gemini บอกว่า\n'), true);
  assert.equal(NativeRecovery.isPlaceholderOnly('Gemini says:'), true);
  assert.equal(NativeRecovery.isPlaceholderOnly(''), true);
  assert.equal(NativeRecovery.isPlaceholderOnly('It is Paris.'), false);
});

test('generatingSignal reports WHICH selector matched, not just a boolean', () => {
  // A dead selector is otherwise invisible: the wait silently degrades to
  // text-stability. Reporting provenance is what makes that loud.
  const inResponse = {
    querySelector: (s) => (s === 'div.loading-content-spinner-container' ? {} : null)
  };
  const doc = {
    querySelectorAll: () => [inResponse],
    querySelector: () => null
  };
  assert.deepEqual(NativeRecovery.generatingSignal(doc),
    { active: true, source: 'response_spinner' });

  const lottie = {
    querySelectorAll: () => [],
    querySelector: (s) => (s === 'clipPath[id^="__lottie_element"]' ? {} : null)
  };
  assert.equal(NativeRecovery.generatingSignal(lottie).source, 'lottie_clippath');

  assert.deepEqual(NativeRecovery.generatingSignal({ querySelectorAll: () => [], querySelector: () => null }),
    { active: false, source: 'none' });
});

test('the sidenav chat-history spinner is NOT treated as generating', () => {
  // THE BUG (KAN-177). `div.loading-content-spinner-container` and
  // `mat-progress-spinner.mat-mdc-progress-spinner` render permanently in the
  // left sidenav while it loads recent chats — aria-label "กำลังโหลด Gem และ
  // การสนทนาล่าสุด", path SIDE-NAVIGATION-CONTENT → BARD-SIDENAV. An unscoped
  // document.querySelector matched it forever, so `waitFor((d) =>
  // !generatingSignal(d).active, ...)` could never resolve and every native
  // retry burned its whole budget. Verified live: a finished 3,460-char answer
  // with no stop button still had the sidenav spinner present.
  const sidenavSpinner = {
    closest: (sel) => (sel.includes('bard-sidenav') ? {} : null)
  };
  const doc = {
    querySelectorAll: () => [],
    querySelector: (s) =>
      s === 'div.loading-content-spinner-container' ||
      s === 'mat-progress-spinner.mat-mdc-progress-spinner'
        ? sidenavSpinner
        : null
  };

  const out = NativeRecovery.generatingSignal(doc);
  assert.equal(out.active, false, 'a sidenav spinner must not report "generating"');
  assert.equal(out.source, 'sidenav_spinner_rejected', 'the guard must be visible in logs');
  assert.equal(NativeRecovery.isGenerating(doc), false);
});

test('a spinner inside the newest response IS a real generation signal', () => {
  // The guard must not over-correct: a spinner scoped to the response is the
  // genuine signal the wait is supposed to block on.
  const response = {
    querySelector: (s) =>
      s === 'mat-progress-spinner.mat-mdc-progress-spinner' || s === 'div.loading-content-spinner-container'
        ? { closest: () => null }
        : null
  };
  const out = NativeRecovery.generatingSignal({ querySelectorAll: () => [response], querySelector: () => null });
  assert.equal(out.active, true);
  assert.equal(out.source, 'response_spinner');
});

test('a spinner outside the sidenav but with no response is not trusted', () => {
  // Belt and braces: an unattributable spinner must not wedge the wait open.
  const orphan = { closest: () => null };
  const doc = {
    querySelectorAll: () => [],
    querySelector: (s) => (s === 'div.loading-content-spinner-container' ? orphan : null)
  };
  const out = NativeRecovery.generatingSignal(doc);
  assert.equal(out.active, false);
  assert.equal(out.source, 'unscoped_spinner_no_response');
});

test('generatingSignal keeps the Material spinner ahead of the falsified Lottie one', () => {
  // The `__lottie_element_<n>` clipPath was probed for 25s across a real
  // generation and matched nothing on this build. It must not become the
  // primary signal, or the wait silently degrades to text-stability.
  const source = readFileSync(
    new URL('../../extension-cloudflare/native-recovery.js', import.meta.url), 'utf8'
  );
  const start = source.indexOf('function generatingSignal');
  const end = source.indexOf('\n  }', start);
  assert.ok(start !== -1 && end > start, 'generatingSignal must exist');
  const body = source.slice(start, end);
  const material = body.indexOf('loading-content-spinner-container');
  const lottie = body.indexOf('__lottie_element');
  assert.ok(material !== -1, 'the Material spinner must still be checked');
  assert.ok(lottie === -1 || material < lottie, 'Material must be checked before the falsified Lottie one');
  // The sidenav guard must exist, or the false positive returns silently.
  assert.ok(body.includes('bard-sidenav'), 'the sidenav guard must be present in generatingSignal');
});

test('the Lottie clipPath probe was falsified on the live DOM, kept only as fallback', () => {
  // The `__lottie_element_<n>` clipPath was probed for 25s across a real
  // generation and matched nothing on this build. It must not be the PRIMARY
  // signal, or the wait silently degrades to text-stability every time.
  const source = readFileSync(
    new URL('../../extension-cloudflare/native-recovery.js', import.meta.url), 'utf8'
  );
  const start = source.indexOf('function generatingSignal');
  const end = source.indexOf('\n  }', start);
  assert.ok(start !== -1 && end > start, 'generatingSignal must exist');
  const body = source.slice(start, end);
  const material = body.indexOf('loading-content-spinner-container');
  const lottie = body.indexOf('__lottie_element');
  assert.ok(material !== -1, 'the verified Material spinner must be checked');
  assert.ok(
    lottie === -1 || material < lottie,
    'the verified Material spinner must be checked before the falsified Lottie one'
  );
});

test('thinking-dots alone is not treated as still generating', () => {
  // It appears only during the thinking phase and can vanish before the
  // answer is finished, so it must not keep the wait open.
  const thinkingOnly = {
    querySelectorAll: () => [],
    querySelector: (s) => (s === 'div.thinking-dots-animation' ? {} : null)
  };
  assert.equal(NativeRecovery.isGenerating(thinkingOnly), false);
});

test('a leaked system preamble is an upstream error, not an answer', () => {
  // Observed on 4.6.0 as a clean 200 with real text, so every earlier check
  // passed it. "I only have the task of generating text" is not an answer.
  for (const t of [
    'คำถามที่ถามมาอยู่นอกเหนือขอบเขตโปรแกรมที่ฉันมี ฉันมีหน้าที่สร้างข้อความเท่านั้น',
    'The question is outside the scope of my program.',
    'My only task is generating text.'
  ]) {
    assert.equal(classifyGeminiReply(t).kind, REFUSAL_KIND.UPSTREAM_ERROR, t.slice(0, 40));
  }
  // A real answer that merely discusses scope must still pass.
  assert.equal(
    classifyGeminiReply('That design is outside the scope of a weekend build.').kind,
    REFUSAL_KIND.ANSWERED
  );
});

test('the notebook phrasing of the same leak is also caught', () => {
  // horo_consult runs against a NotebookLM notebook and leaks a different
  // sentence for the same underlying failure. Scoring this as `answered` is
  // what made a non-functional tool look healthy.
  for (const t of [
    'ฉันไม่ได้รับการโปรแกรมมาให้ทำเรื่องนี้',
    'I was not given a program to handle this.'
  ]) {
    assert.equal(classifyGeminiReply(t).kind, REFUSAL_KIND.UPSTREAM_ERROR, t.slice(0, 40));
  }
});

test('retryViaUi does not resolve on the placeholder mid-stream', async () => {
  // Gemini renders "Gemini บอกว่า" first, then streams the real answer. A
  // change-only detector returns the label; this must wait for the answer.
  const response = makeResponse({ testIdButton: { click() {} } });
  const doc = makeDoc({ responses: [response] });
  response.querySelector('[data-test-id="regenerate-button"]').click = () => {
    response.innerText = 'Gemini บอกว่า';
    setTimeout(() => { response.innerText = 'It is Paris.'; }, 30);
  };
  const out = await NativeRecovery.retryViaUi({ doc, settleMs: 0, timeoutMs: 3000 });
  assert.equal(out.ok, true);
  assert.equal(out.text, 'It is Paris.', 'must not return the placeholder label');
});
