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

test('the live Material spinner is the generation-in-progress signal', () => {
  // Verified against the real Gemini DOM (boq-gemini-web-uiserver 20260927.05)
  // during a 1500-word generation:
  //   <div class="loading-content-spinner-container ng-star-inserted">
  //     <mat-progress-spinner class="mat-mdc-progress-spinner mdc-circular-progress">
  const MATERIAL = [
    'div.loading-content-spinner-container',
    'mat-progress-spinner.mat-mdc-progress-spinner'
  ];
  for (const sel of MATERIAL) {
    const spinning = { querySelector: (s) => (s === sel ? {} : null) };
    assert.equal(NativeRecovery.isGenerating(spinning), true, sel);
  }
  assert.equal(NativeRecovery.isGenerating({ querySelector: () => null }), false);
});

test('the Lottie clipPath probe was falsified on the live DOM, kept only as fallback', () => {
  // The `__lottie_element_<n>` clipPath was probed for 25s across a real
  // generation and matched nothing on this build. It must not be the PRIMARY
  // signal, or the wait silently degrades to text-stability every time.
  const source = readFileSync(
    new URL('../../extension-cloudflare/native-recovery.js', import.meta.url), 'utf8'
  );
  const start = source.indexOf('function isGenerating');
  const end = source.indexOf('\n  }', start);
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
