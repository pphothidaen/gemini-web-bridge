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
const PromptTyping = require('../../extension-cloudflare/prompt-typing.js');
const GeminiInjected = require('../../extension-cloudflare/injected.js');

// ── Prompt typing fallback (KAN-182) ────────────────────────────────────────
//
// The three obvious ways to fill Gemini's rich-text editor were each tested
// against a live tab, and each fails DIFFERENTLY while looking like success:
//   1. `textContent` + synthetic InputEvent → the text lands TWICE, because
//      Quill reconciles its own model against a DOM that already holds a copy.
//   2. `quill.setText(t, 'api')`          → correct text, but NO send button,
//      because Angular never learns the editor has content.
//   3. `quill.setText(t, 'user')`         → correct text AND the send button
//      appears, because 'user' makes Quill emit keystroke-equivalent events.
// The tests below pin that distinction, because the bug it prevents is silent.

test('the typing fallback uses only localization-proof selectors', () => {
  const S = PromptTyping.SELECTORS;
  // The send button's accessible name is "ส่งข้อความ" in Thai and "Send message"
  // in English, so it is keyed on the icon name instead.
  for (const [name, sel] of Object.entries(S)) {
    assert.ok(!String(sel).includes('ส่ง'), `SELECTORS.${name} must not match the Thai send label`);
    assert.ok(!/send message/i.test(String(sel)), `SELECTORS.${name} must not match the English send label`);
  }
  assert.equal(S.editor, 'input-area-v2 .ql-editor[contenteditable="true"]');
  assert.ok(S.sendButton.includes('arrow_upward'));
});

test('the prompt is set through Quill with source "user", not via textContent', () => {
  // Case 1 above. A regression here duplicates every prompt the user sends.
  const calls = [];
  const quill = {
    setText: (v, source) => calls.push({ v, source }),
    setSelection: () => {},
    getLength: () => 5
  };
  const editor = { innerText: 'hello world', focus() {} };
  const doc = {
    querySelector: (sel) => (sel === PromptTyping.SELECTORS.richTextarea ? { __quill: quill }
      : sel === PromptTyping.SELECTORS.editor ? editor : null)
  };

  assert.equal(PromptTyping.setPromptText('hello world', doc), true);
  assert.equal(calls.length, 1);
  // 'api' would produce the right text with no send button; only 'user' emits
  // the events Angular listens for.
  assert.equal(calls[0].source, 'user', "Quill must be driven with source 'user'");
});

test('setPromptText reports failure when the text does not land', () => {
  // The read-back is the point: setting text and returning true regardless is
  // exactly how the doubled-text bug survived looking like a working path.
  const quill = { setText: () => {}, setSelection: () => {}, getLength: () => 0 };
  const editor = { innerText: 'something else entirely', focus() {} };
  const doc = {
    querySelector: (sel) => (sel === PromptTyping.SELECTORS.richTextarea ? { __quill: quill }
      : sel === PromptTyping.SELECTORS.editor ? editor : null)
  };
  assert.equal(PromptTyping.setPromptText('the prompt', doc), false);
  assert.equal(PromptTyping.setPromptText('', doc), false);
  assert.equal(PromptTyping.setPromptText('   ', doc), false);
});

// KAN-182: the live run on 2026-09-29 showed the `__quill` property was NOT
// reachable on the tab, and the old textContent fallback left the editor
// `ql-blank` — no prompt, no answer, and the call reported the previous
// turn's text. execCommand('insertText') is the path that produces the real
// beforeinput/input pair Quill's own listeners react to.
test('KAN-182: without a Quill instance, text goes in via execCommand', () => {
  const calls = [];
  const editor = {
    innerText: '',
    ownerDocument: null,
    focus() { calls.push('focus'); },
    dispatchEvent(e) { calls.push(`input:${e.inputType}`); return true; },
    set textContent(v) { this.innerText = v; },
    get textContent() { return this.innerText; }
  };
  const host = {
    getSelection: () => ({
      removeAllRanges() {}, addRange() {}
    }),
    createRange: () => ({ selectNodeContents() {} }),
    execCommand: (cmd, _ui, value) => { calls.push(`exec:${cmd}`); editor.innerText = value; return true; }
  };
  editor.ownerDocument = host;

  const doc = {
    querySelector: (sel) => {
      if (sel === PromptTyping.SELECTORS.richTextarea) return { querySelector: () => null };
      if (sel === PromptTyping.SELECTORS.editor) return editor;
      return null;
    }
  };

  assert.equal(PromptTyping.setPromptText('ทดสอบข้อความ', doc), true);
  assert.ok(calls.includes('exec:insertText'), 'must use execCommand, not textContent alone');
  // Focus is a prerequisite: execCommand on a blurred editable does nothing.
  assert.equal(calls[0], 'focus', 'the editor must be focused before insertText');
});

test('KAN-182: getQuill also looks on the inner editor, not just the host', () => {
  // The 2026-09-29 build may hang the instance off either element. Returning
  // null for both is what silently disabled the working path.
  const quill = { setText() {} };
  const host = { querySelector: () => ({ __quill: quill }) };
  const doc = { querySelector: (sel) => (sel === PromptTyping.SELECTORS.richTextarea ? host : null) };
  assert.equal(PromptTyping.getQuill(doc), quill);
});

test('KAN-182: a missing Quill instance is not fatal — the editor path still runs', () => {
  // The regression that mattered: the old code had NO usable fallback, so a
  // null Quill meant a silently empty editor and a stale answer.
  const editor = {
    innerText: '',
    focus() {},
    dispatchEvent: () => true,
    set textContent(v) { this.innerText = v; },
    get textContent() { return this.innerText; }
  };
  editor.ownerDocument = { execCommand: (_c, _u, v) => { editor.innerText = v; return true; } };

  const doc = {
    querySelector: (sel) => {
      if (sel === PromptTyping.SELECTORS.richTextarea) return { querySelector: () => null };
      if (sel === PromptTyping.SELECTORS.editor) return editor;
      return null;
    }
  };
  assert.equal(PromptTyping.getQuill(doc), null, 'no Quill here — that is the live condition');
  assert.equal(PromptTyping.setPromptText('still typed', doc), true, 'but the prompt still lands');
});

test('KAN-182: execCommand declining falls back to a direct write', () => {
  // execCommand returns false in some engines. A direct write plus the
  // read-back is better than an empty editor, and the read-back still reports
  // the truth rather than assuming success.
  const editor = {
    innerText: '',
    focus() {},
    dispatchEvent: () => true,
    set textContent(v) { this.innerText = v; },
    get textContent() { return this.innerText; }
  };
  editor.ownerDocument = { execCommand: () => false };

  const doc = {
    querySelector: (sel) => {
      if (sel === PromptTyping.SELECTORS.richTextarea) return { querySelector: () => null };
      if (sel === PromptTyping.SELECTORS.editor) return editor;
      return null;
    }
  };
  assert.equal(PromptTyping.setPromptText('fallback text', doc), true);
});

test('a HIDDEN tab is refused before anything is typed', async () => {
  // A backgrounded tab does not commit the prompt, so typing would be a
  // silent no-op that looks like a successful submit.
  const doc = { hidden: true, querySelector: () => null, querySelectorAll: () => [] };
  const out = await PromptTyping.typeAndSend({
    prompt: 'q', doc, log: () => {}, sleep: async () => {}, setT: () => {}
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'tab_not_visible');
  assert.equal(out.step, 'visibility');
});

test('an empty prompt is rejected without touching the DOM', async () => {
  const doc = { hidden: false, querySelector: () => null, querySelectorAll: () => [] };
  const out = await PromptTyping.typeAndSend({
    prompt: '   ', doc, log: () => {}, sleep: async () => {}, setT: () => {}
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'empty_prompt');
});

test('a missing send button is a distinct failure from a rejected prompt', async () => {
  // The editor accepted the text but Gemini never rendered a send control:
  // a different diagnosis from "the text did not land", and conflating them
  // would send an operator looking in the wrong place.
  const quill = { setText: () => {}, setSelection: () => {}, getLength: () => 7 };
  const editor = { innerText: 'a prompt', focus() {} };
  const doc = {
    hidden: false,
    querySelector: (sel) => (sel === PromptTyping.SELECTORS.richTextarea ? { __quill: quill }
      : sel === PromptTyping.SELECTORS.editor ? editor : null),
    querySelectorAll: () => []
  };
  const out = await PromptTyping.typeAndSend({
    prompt: 'a prompt', doc, timeoutMs: 40, log: () => {}, sleep: async () => {},
    setT: (fn, ms) => setTimeout(fn, ms), now: Date.now
  });
  assert.equal(out.ok, false);
  assert.equal(out.step, 'send_button');
});

test('a clicked send that produces no user-query is reported, not assumed sent', async () => {
  // The distinction between "we clicked" and "Gemini accepted it". A click on
  // a re-rendered control does nothing, and reporting success there is how a
  // dead prompt silently becomes a 60s timeout.
  const quill = { setText: () => {}, setSelection: () => {}, getLength: () => 7 };
  const editor = { innerText: 'a prompt', focus() {} };
  const send = { hasAttribute: () => false, getAttribute: () => null, click: () => {} };
  const doc = {
    hidden: false,
    querySelector: (sel) => {
      if (sel === PromptTyping.SELECTORS.richTextarea) return { __quill: quill };
      if (sel === PromptTyping.SELECTORS.editor) return editor;
      if (sel === PromptTyping.SELECTORS.sendButton) return send;
      return null;
    },
    querySelectorAll: (sel) => (sel === 'user-query' ? [] : [])
  };
  const out = await PromptTyping.typeAndSend({
    prompt: 'a prompt', doc, timeoutMs: 40, log: () => {}, sleep: async () => {},
    setT: (fn, ms) => setTimeout(fn, ms), now: Date.now
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'prompt_not_submitted');
  assert.equal(out.step, 'confirm');
});

test('a full successful submit is reported as submitted', async () => {
  // The happy path end to end, so the guard above cannot be satisfied by a
  // flow that never submits at all.
  let queries = 0;
  const quill = { setText: () => {}, setSelection: () => {}, getLength: () => 7 };
  const editor = { innerText: 'a prompt', focus() {} };
  const send = {
    hasAttribute: () => false,
    getAttribute: () => null,
    click: () => { queries = 1; }
  };
  const doc = {
    hidden: false,
    querySelector: (sel) => {
      if (sel === PromptTyping.SELECTORS.richTextarea) return { __quill: quill };
      if (sel === PromptTyping.SELECTORS.editor) return editor;
      if (sel === PromptTyping.SELECTORS.sendButton) return send;
      return null;
    },
    querySelectorAll: (sel) => (sel === 'user-query' ? new Array(queries) : [])
  };
  const out = await PromptTyping.typeAndSend({
    prompt: 'a prompt', doc, timeoutMs: 500, log: () => {}, sleep: async () => {},
    setT: (fn, ms) => setTimeout(fn, ms), now: Date.now
  });
  assert.equal(out.ok, true);
  assert.equal(out.submitted, true);
});

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

test('KAN-182: a leftover chip does NOT short-circuit the attach', async () => {
  // The regression this pins. Grounding is consumed PER MESSAGE, not per
  // conversation — measured from real StreamGenerate payloads on
  // 2026-09-29:
  //
  //   attach -> send             payload HAS notebook://…/sources/…
  //   send again, no re-attach   payload has NO notebook reference
  //
  // The old code returned {ok:true, alreadyAttached:true} here, so from the
  // second horo_consult call onward the answer was written from general
  // knowledge while the tool reported it as grounded. There is no way for a
  // caller to detect that from the answer text.
  //
  // So a chip left in the input area is stale state, not a satisfied
  // precondition: it must be cleared and the full flow run again.
  const chip = {
    innerText: 'Horo',
    textContent: 'Horo',
    querySelector: (sel) => (sel === 'button' ? { click: () => { chip.removed = true; } } : null)
  };
  const doc = {
    hidden: false,
    querySelectorAll: (sel) => (sel === NotebookAttach.SELECTORS.attachedChip ? [chip] : []),
    // No "+" button, so a real attach attempt fails at open_plus. What
    // matters is that it got that far instead of returning early.
    querySelector: () => null
  };
  const out = await NotebookAttach.attachNotebook({
    notebookName: 'Horo', doc, log: () => {}, sleep: async () => {}, setT: () => {}
  });

  assert.equal(chip.removed, true, 'the stale chip must be removed before re-attaching');
  assert.equal(out.ok, false);
  assert.equal(out.step, 'open_plus', 'it must attempt the full flow, not return early');
  assert.equal(out.alreadyAttached, undefined, 'alreadyAttached must no longer be reported at all');
});

test('KAN-182: a fresh attach is performed on every call, not just the first', async () => {
  // Two consecutive horo_consult calls in the same conversation. The second
  // one has no chip left (Gemini consumed it on send), so it must still run
  // the full flow and reach the same terminal step as the first — proving
  // nothing is skipped on the repeat call.
  const runOnce = async (withChip) => {
    const doc = {
      hidden: false,
      querySelectorAll: (sel) => (sel === NotebookAttach.SELECTORS.attachedChip && withChip ? [] : []),
      querySelector: () => null
    };
    return NotebookAttach.attachNotebook({
      notebookName: 'Horo', doc, log: () => {}, sleep: async () => {}, setT: () => {}
    });
  };
  const first = await runOnce(false);
  const second = await runOnce(false);
  assert.equal(first.step, second.step);
  assert.equal(first.step, 'open_plus');
  assert.equal(second.ok, false, 'the flow is attempted, not silently skipped');
});

test('KAN-182: grounding is read from the NEWEST response only', () => {
  // The trap: source-inline-chip elements from earlier replies stay in the
  // DOM for the life of the conversation. A document-wide search finds
  // citations from a grounded answer three turns ago and reports the current
  // ungrounded reply as grounded.
  const stale = {
    innerText: 'an old grounded answer [cite: 1]',
    querySelectorAll: (sel) => (sel === 'source-inline-chip' ? [{ innerText: 'Old source' }] : [])
  };
  const fresh = {
    innerText: 'a new answer with no citations at all',
    querySelectorAll: (sel) => (sel === 'source-inline-chip' ? [] : [])
  };
  const doc = {
    querySelectorAll: (sel) => (sel === 'model-response' ? [stale, fresh] : [])
  };

  const out = NotebookAttach.readGroundingEvidence({ doc });
  assert.equal(out.verified, false, 'a stale chip from an earlier response must not count');
  assert.equal(out.reason, 'no_citations_in_response');
  assert.equal(out.chipCount, 0);
});

test('KAN-182: the newest response is grounded when it carries its own citations', () => {
  const stale = {
    innerText: 'old',
    querySelectorAll: (sel) => (sel === 'source-inline-chip' ? [{ innerText: 'Old' }] : [])
  };
  const fresh = {
    innerText: 'คำตอบที่อ้างอิง [cite: 23]',
    querySelectorAll: (sel) =>
      sel === 'source-inline-chip' ? [{ innerText: 'ยกระดับสถาปัตยกรรมพร้อมท์บอทโหราศาสตร์จีน' }] : []
  };
  const doc = {
    querySelectorAll: (sel) => (sel === 'model-response' ? [stale, fresh] : [])
  };

  const out = NotebookAttach.readGroundingEvidence({ doc });
  assert.equal(out.verified, true);
  assert.equal(out.chipCount, 1);
  assert.equal(out.citeMarkers, 1);
  assert.deepEqual(out.sources, ['ยกระดับสถาปัตยกรรมพร้อมท์บอทโหราศาสตร์จีน']);
});

test('KAN-182: cite markers alone count as grounding evidence', () => {
  // A streamed answer can render its text before its chips, so text markers
  // are checked too. Either signal is sufficient; both are reported.
  const response = {
    innerText: 'ตอบโดยอ้างอิง [cite: 7] และ [cite: 8]',
    querySelectorAll: () => []
  };
  const doc = { querySelectorAll: (sel) => (sel === 'model-response' ? [response] : []) };

  const out = NotebookAttach.readGroundingEvidence({ doc });
  assert.equal(out.verified, true);
  assert.equal(out.chipCount, 0);
  assert.equal(out.citeMarkers, 2);
});

test('KAN-182: no rendered response is an explicit unverified state', () => {
  // Distinct from "rendered but uncited", so an operator can tell a broken
  // collection from a genuinely ungrounded answer.
  const doc = { querySelectorAll: () => [] };
  const out = NotebookAttach.readGroundingEvidence({ doc });
  assert.equal(out.verified, false);
  assert.equal(out.reason, 'no_response_rendered');
});

test('KAN-182: grounding selectors are not tied to a localized label', () => {
  const S = NotebookAttach.SELECTORS;
  assert.equal(S.modelResponse, 'model-response');
  assert.equal(S.sourceChip, 'source-inline-chip');
  for (const word of ['แหล่งที่มา', 'อ้างอิง', 'Sources', 'Citations']) {
    assert.ok(!S.sourceChip.includes(word));
    assert.ok(!S.modelResponse.includes(word));
  }
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

// KAN-182: the stale-answer trap, proven live on 2026-09-29.
//
// horo_consult was asked a question while the conversation already held a
// previous exchange. The typed prompt never landed — the editor was empty and
// the notebook chip was still sitting unconsumed in the input area — yet the
// call returned text. That text was the PREVIOUS turn's answer, read out of
// the last `model-response` after the wait timed out.
//
// It then failed grounding on it, so the reported reason was
// "no_citations_in_response" — which points the operator at the notebook when
// the real fault is that no question was ever asked. Two different bugs, one
// misleading symptom.

function makeDocWithResponse(text) {
  const response = {
    innerText: text,
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null
  };
  // Returned NESTED under `doc` on purpose: waitForResponseChange has a
  // `doc = document` default parameter, so passing `undefined` silently falls
  // back to the real global and throws in Node. Destructuring a flat object as
  // `{ doc }` produced exactly that ReferenceError.
  return {
    doc: {
      querySelectorAll: (sel) => (sel === 'model-response' ? [response] : []),
      querySelector: () => null
    },
    response
  };
}

test('KAN-182: a timeout returns NO text, never the previous turn\'s answer', async () => {
  const previous = 'ทดสอบ C: แนบซ้ำแล้ว grounding ซ้อนไหม — การแนบไฟล์ซ้ำไม่ทำให้เกิดการอ้างอิงซ้อนครับ';
  const { doc } = makeDocWithResponse(previous);

  // A real `now` is required — the default is Date.now, which the fake timers
  // below never advance, so the wait would spin against wall-clock time.
  let clock = 0;
  const result = await NativeRecovery.waitForResponseChange({
    previousText: previous,
    minResponses: 1,
    timeoutMs: 50,
    doc,
    now: () => clock,
    setT: (fn) => setTimeout(() => { clock += 25; fn(); }, 1)
  });

  assert.equal(result.changed, false, 'nothing changed, so this must report no change');
  // The whole point. Returning `previous` here is what made horo_consult
  // answer with the last turn's text.
  assert.equal(result.text, '', 'a timeout must not hand back the previous response');
});

test('KAN-182: a genuinely new answer is still returned', async () => {
  // The guard above must not break the working path. This covers an IN-PLACE
  // text change (what regenerate does), so it uses the permissive default —
  // the count-based attribution has its own test below.
  const previous = 'old answer';
  const { doc, response } = makeDocWithResponse(previous);
  setTimeout(() => { response.innerText = 'a brand new grounded answer [cite: 3]'; }, 5);

  const result = await NativeRecovery.waitForResponseChange({
    previousText: previous, timeoutMs: 3000, doc
  });
  assert.equal(result.changed, true);
  assert.equal(result.text, 'a brand new grounded answer [cite: 3]');
});

// KAN-182, live run 2. The 4.7.2 fix rejected a TIMEOUT, but the run still
// reported success: `collectTypedAnswer` returned the newest response, which
// was the previous turn's answer. It was stable, non-placeholder, and — after
// anything re-rendered mid-wait — different from the text captured at the
// start. Text cannot attribute an answer to a request; the response COUNT can.
test('KAN-182: a response older than the snapshot is rejected even if its text differs', async () => {
  const old = makeResponse({ testIdButton: { click() {} } });
  old.innerText = 'the previous turn, still on screen';
  const doc = makeDoc({ responses: [old] });

  // minResponses says a response newer than the one on screen is required.
  // Nothing ever appends one, so this must never resolve as changed — no
  // matter how the old text behaves.
  const result = await NativeRecovery.waitForResponseChange({
    previousText: 'whatever was captured at the start',
    minResponses: 1,
    timeoutMs: 60,
    doc
  });

  assert.equal(result.changed, false, 'an older response must never count as new');
  assert.equal(result.text, '', 'and its text must not be returned');
  assert.equal(result.responses, 1, 'the count is reported so the caller can say what it saw');
});

test('KAN-182: countModelResponses counts, and survives a document with none', () => {
  assert.equal(NativeRecovery.countModelResponses(makeDoc({ responses: [1, 2, 3] })), 3);
  assert.equal(NativeRecovery.countModelResponses(makeDoc({ responses: [] })), 0);
  // A document that throws must not take the caller down with it.
  assert.equal(NativeRecovery.countModelResponses({ querySelectorAll: () => { throw new Error('nope'); } }), 0);
});

test('KAN-182: a newly appended response is accepted', async () => {
  // The positive half of the attribution test: the count grows, so the answer
  // is genuinely this request's.
  const old = makeResponse({ testIdButton: { click() {} } });
  old.innerText = 'previous turn';
  const fresh = makeResponse({ testIdButton: { click() {} } });
  const doc = makeDoc({ responses: [old] });

  setTimeout(() => {
    doc.querySelectorAll = (sel) => (sel === 'model-response' ? [old, fresh] : []);
    fresh.innerText = 'the answer to my question [cite: 7]';
  }, 5);

  const result = await NativeRecovery.waitForResponseChange({
    previousText: 'previous turn', minResponses: 1, timeoutMs: 3000, doc
  });
  assert.equal(result.changed, true);
  assert.equal(result.responses, 2);
  assert.equal(result.text, 'the answer to my question [cite: 7]');
});

test('KAN-182: minResponses defaults to 0 so regenerate-in-place still works', async () => {
  // retryViaUi clicks "regenerate", which re-renders the SAME element rather
  // than appending. With a non-zero floor that path could never resolve, so
  // the default has to stay permissive and callers opt in explicitly.
  const response = makeResponse({ testIdButton: { click() {} } });
  response.innerText = 'old';
  const doc = makeDoc({ responses: [response] });
  setTimeout(() => { response.innerText = 'regenerated in place'; }, 5);

  const result = await NativeRecovery.waitForResponseChange({
    previousText: 'old', timeoutMs: 3000, doc
  });
  assert.equal(result.changed, true);
  assert.equal(result.text, 'regenerated in place');
});

test('KAN-182: retryViaUi still recovers the answer after the change-wait times out', async () => {
  // retryViaUi calls waitForResponseChange with a short 4s settle budget and
  // then re-reads the DOM itself, so the new "" return value must not break it.
  const response = makeResponse({ testIdButton: { click() {} } });
  const doc = makeDoc({ responses: [response] });
  response.querySelector('[data-test-id="regenerate-button"]').click = () => {
    response.innerText = 'It is Paris.';
  };
  const out = await NativeRecovery.retryViaUi({ doc, settleMs: 0, timeoutMs: 50 });
  assert.equal(out.ok, true);
  assert.equal(out.text, 'It is Paris.');
});

// KAN-182: the MAIN-world relay. This is the architectural fix — the isolated
// world shares the DOM with the page but NOT JavaScript expandos, so the
// `__quill` property Angular sets is invisible to prompt-typing.js no matter
// how the lookup is written. injected.js runs in the MAIN world and can see it.

function makeFakeWindow() {
  const listeners = [];
  const posted = [];
  // Declared first and referenced by the handlers below, so the simulated
  // MAIN world can echo `source: win` the way a real one does.
  const win = {
    listeners,
    posted,
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    removeEventListener: (type, fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    postMessage: (msg) => {
      posted.push(msg);
      // Simulate the MAIN world answering on the next tick.
      if (msg && msg.type === 'TYPE_PROMPT_INTO_EDITOR') {
        setTimeout(() => {
          listeners.slice().forEach((fn) => fn({
            source: win,
            data: {
              source: 'GEMINI_INJECTED',
              type: 'PROMPT_TYPED',
              requestId: msg.requestId,
              ok: true,
              reason: '',
              text: msg.payload.text
            }
          }));
        }, 1);
      }
    }
  };
  return win;
}

test('KAN-182: typing is relayed to the MAIN world, which owns the Quill instance', async () => {
  const win = makeFakeWindow();
  const prev = globalThis.window;
  globalThis.window = win;
  try {
    const out = await PromptTyping.typeViaMainWorld('ทดสอบข้อความ');
    assert.equal(out.ok, true);
    assert.equal(out.text, 'ทดสอบข้อความ', 'the read-back comes from the MAIN world, not the write');
    assert.equal(win.posted.length, 1);
    const msg = win.posted[0];
    assert.equal(msg.source, 'GEMINI_CONTENT');
    assert.equal(msg.type, 'TYPE_PROMPT_INTO_EDITOR');
    // A requestId must be present: the reply is matched on it, or concurrent
    // calls would steal each other's answers.
    assert.ok(msg.requestId, 'the request must be correlatable');
    assert.equal(msg.payload.text, 'ทดสอบข้อความ');
    // The listener must be removed, or every call leaks one.
    assert.equal(win.listeners.length, 0, 'the message listener must be cleaned up');
  } finally {
    globalThis.window = prev;
  }
});

test('KAN-182: a silent MAIN world times out instead of hanging the call', async () => {
  // The window accepts messages but never replies. Without the timeout the
  // request would wait forever, and the send-button wait after it would never
  // be reached.
  const win = makeFakeWindow();
  win.postMessage = () => {};           // swallow, never answer
  const prev = globalThis.window;
  globalThis.window = win;
  try {
    const out = await PromptTyping.typeViaMainWorld('hello', { timeoutMs: 30, setT: setTimeout });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'main_world_timeout');
    assert.equal(win.listeners.length, 0, 'the listener is removed on timeout too');
  } finally {
    globalThis.window = prev;
  }
});

test('KAN-182: a reply for a different request is ignored', async () => {
  // Two calls in flight must not cross. A reply whose requestId does not match
  // is someone else's answer.
  const win = makeFakeWindow();
  const prev = globalThis.window;
  globalThis.window = win;
  try {
    // Neutralise the auto-reply so ONLY the foreign reply can arrive.
    win.postMessage = () => {};
    const p = PromptTyping.typeViaMainWorld('mine', { timeoutMs: 40, setT: setTimeout });
    // Inject a foreign reply; it must not resolve our promise.
    setTimeout(() => {
      win.listeners.slice().forEach((fn) => fn({
        source: win,
        data: { source: 'GEMINI_INJECTED', type: 'PROMPT_TYPED', requestId: 'someone-else', ok: true, text: 'not mine' }
      }));
    }, 1);
    const out = await p;
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'main_world_timeout', 'only a matching reply may resolve it');
  } finally {
    globalThis.window = prev;
  }
});

test('KAN-182: an absent window degrades instead of throwing', async () => {
  const prev = globalThis.window;
  delete globalThis.window;
  try {
    const out = await PromptTyping.typeViaMainWorld('hello');
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'no_window');
  } finally {
    if (prev !== undefined) globalThis.window = prev;
  }
});

test('KAN-182: setPromptTextAsync falls back to the DOM when the MAIN world is silent', async () => {
  // The bridge is best-effort. A page where injected.js did not load must still
  // attempt the write rather than failing outright — and the read-back is what
  // decides, not optimism.
  const win = makeFakeWindow();
  win.postMessage = () => {};
  const prev = globalThis.window;
  globalThis.window = win;

  const editor = {
    innerText: '',
    focus() {},
    dispatchEvent: () => true,
    set textContent(v) { this.innerText = v; },
    get textContent() { return this.innerText; }
  };
  const doc = {
    querySelector: (sel) => (sel === PromptTyping.SELECTORS.editor ? editor : null)
  };

  try {
    const out = await PromptTyping.setPromptTextAsync('fallback path', { doc, timeoutMs: 20, setT: setTimeout });
    assert.equal(out, true, 'the DOM fallback must still be attempted');
    assert.equal(editor.innerText, 'fallback path');
  } finally {
    globalThis.window = prev;
  }
});

test('KAN-182: setPromptTextAsync returns false for an empty prompt', async () => {
  assert.equal(await PromptTyping.setPromptTextAsync(''), false);
  assert.equal(await PromptTyping.setPromptTextAsync('   '), false);
});

// ── MAIN-world prompt typing in injected.js (KAN-182) ──────────────────────
//
// Background: injected.js runs in Chrome's MAIN world to access Quill (__quill)
// and Angular's internal model, which are invisible to the ISOLATED content script.
// These tests validate its core typing, settling, reconciliation, and sync logic
// without running the browser side-effects.

test('MAIN-world typing: a text that survives settling is reported as landed (ok:true, settled:true)', async () => {
  let quillText = '';
  let quillSource = '';
  const mockQuill = {
    setText: (t, src) => { quillText = t; quillSource = src; },
    setSelection: () => {},
    getLength: () => quillText.length
  };
  const editor = {
    className: 'ql-editor',
    innerText: 'Hello from MAIN world',
    textContent: 'Hello from MAIN world',
    dispatchEvent: () => true
  };
  const host = {
    __quill: mockQuill,
    querySelector: (sel) => (sel === GeminiInjected.PROMPT_EDITOR_SELECTORS.editor ? editor : null)
  };
  const doc = {
    querySelector: (sel) => {
      if (sel === GeminiInjected.PROMPT_EDITOR_SELECTORS.richTextarea) return host;
      if (sel === GeminiInjected.PROMPT_EDITOR_SELECTORS.editor) return editor;
      return null;
    }
  };

  const out = await GeminiInjected.typePromptInMainWorld('Hello from MAIN world', {
    doc,
    settleMs: 1,
    maxAttempts: 3,
    setT: (fn) => setTimeout(fn, 1)
  });

  assert.equal(out.ok, true);
  assert.equal(out.settled, true);
  assert.equal(out.text, 'Hello from MAIN world');
  assert.equal(out.attempts, 1);
  assert.equal(quillSource, 'user');
});

test('MAIN-world typing: a text that Angular reverts before settle is reported as text_reverted_after_settle', async () => {
  let writes = 0;
  const editor = {
    // Angular resets the editor to blank after write
    className: 'ql-editor ql-blank',
    innerText: '',
    textContent: '',
    dispatchEvent: () => true
  };
  const mockQuill = {
    setText: () => { writes++; },
    setSelection: () => {},
    getLength: () => 5
  };
  const host = {
    __quill: mockQuill,
    querySelector: () => editor
  };
  const doc = {
    querySelector: (sel) => {
      if (sel === GeminiInjected.PROMPT_EDITOR_SELECTORS.richTextarea) return host;
      if (sel === GeminiInjected.PROMPT_EDITOR_SELECTORS.editor) return editor;
      return null;
    }
  };

  const out = await GeminiInjected.typePromptInMainWorld('reverted prompt', {
    doc,
    settleMs: 1,
    maxAttempts: 3,
    setT: (fn) => setTimeout(fn, 1)
  });

  assert.equal(out.ok, false);
  assert.equal(out.reason, 'text_reverted_after_settle');
  assert.equal(out.settled, true);
  assert.equal(out.attempts, 3);
  assert.equal(writes, 3);
});

test('MAIN-world typing: ql-blank makes a read count as reverted even when innerText holds text momentarily', async () => {
  // Live failure mode: setText puts the string in innerText, but Angular marks
  // the wrapper ql-blank during reconciliation. A text-only check reports a false success.
  const editor = {
    className: 'ql-editor ql-blank',
    innerText: 'transient text still in DOM',
    textContent: 'transient text still in DOM',
    dispatchEvent: () => true
  };
  const mockQuill = {
    setText: () => {},
    setSelection: () => {},
    getLength: () => 10
  };
  const host = {
    __quill: mockQuill,
    querySelector: () => editor
  };
  const doc = {
    querySelector: (sel) => {
      if (sel === GeminiInjected.PROMPT_EDITOR_SELECTORS.richTextarea) return host;
      if (sel === GeminiInjected.PROMPT_EDITOR_SELECTORS.editor) return editor;
      return null;
    }
  };

  const out = await GeminiInjected.typePromptInMainWorld('transient text still in DOM', {
    doc,
    settleMs: 1,
    maxAttempts: 2,
    setT: (fn) => setTimeout(fn, 1)
  });

  assert.equal(out.ok, false);
  assert.equal(out.reason, 'text_reverted_after_settle');
  assert.equal(out.settled, true);
});

test('MAIN-world typing: a later attempt can win and report attempts count', async () => {
  let attempt = 0;
  const editor = {
    get className() {
      // First attempt is reverted (ql-blank); second attempt sticks.
      return attempt >= 2 ? 'ql-editor' : 'ql-editor ql-blank';
    },
    get innerText() {
      return attempt >= 2 ? 'eventually landed' : '';
    },
    dispatchEvent: () => true
  };
  const mockQuill = {
    setText: () => { attempt++; },
    setSelection: () => {},
    getLength: () => 10
  };
  const host = {
    __quill: mockQuill,
    querySelector: () => editor
  };
  const doc = {
    querySelector: (sel) => {
      if (sel === GeminiInjected.PROMPT_EDITOR_SELECTORS.richTextarea) return host;
      if (sel === GeminiInjected.PROMPT_EDITOR_SELECTORS.editor) return editor;
      return null;
    }
  };

  const out = await GeminiInjected.typePromptInMainWorld('eventually landed', {
    doc,
    settleMs: 1,
    maxAttempts: 3,
    setT: (fn) => setTimeout(fn, 1)
  });

  assert.equal(out.ok, true);
  assert.equal(out.settled, true);
  assert.equal(out.text, 'eventually landed');
  assert.equal(out.attempts, 2);
});

test('MAIN-world typing: retries are strictly bounded by maxAttempts', async () => {
  let attemptsMade = 0;
  const editor = {
    className: 'ql-editor ql-blank',
    innerText: '',
    dispatchEvent: () => true
  };
  const mockQuill = {
    setText: () => { attemptsMade++; },
    setSelection: () => {},
    getLength: () => 5
  };
  const host = {
    __quill: mockQuill,
    querySelector: () => editor
  };
  const doc = {
    querySelector: (sel) => {
      if (sel === GeminiInjected.PROMPT_EDITOR_SELECTORS.richTextarea) return host;
      if (sel === GeminiInjected.PROMPT_EDITOR_SELECTORS.editor) return editor;
      return null;
    }
  };

  const out = await GeminiInjected.typePromptInMainWorld('bound check', {
    doc,
    settleMs: 1,
    maxAttempts: 4,
    setT: (fn) => setTimeout(fn, 1)
  });

  assert.equal(out.ok, false);
  assert.equal(out.attempts, 4);
  assert.equal(attemptsMade, 4);
});

test('MAIN-world typing: a missing editor returns editor_not_found with attempts 0', async () => {
  const doc = {
    querySelector: () => null
  };
  const out = await GeminiInjected.typePromptInMainWorld('any prompt', { doc });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'editor_not_found');
  assert.equal(out.attempts, 0);
  assert.equal(out.text, '');
});

test('MAIN-world typing: an empty or whitespace prompt is rejected before touching the editor', async () => {
  let queried = false;
  const doc = {
    querySelector: () => { queried = true; return null; }
  };

  for (const emptyVal of ['', '   ', '\t\n\r  ', null, undefined]) {
    const out = await GeminiInjected.typePromptInMainWorld(emptyVal, { doc });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'empty_prompt');
    assert.equal(out.attempts, 0);
    assert.equal(out.text, '');
  }
  assert.equal(queried, false, 'must not query the DOM for empty/whitespace prompts');
});

test('MAIN-world typing: syncAngularModel returns false when window.ng is absent', () => {
  const host = {};
  const prevWindow = globalThis.window;
  delete globalThis.window;
  try {
    assert.equal(GeminiInjected.syncAngularModel(host, 'prompt'), false);
  } finally {
    if (prevWindow !== undefined) globalThis.window = prevWindow;
  }

  // Also when window exists but ng property is missing
  globalThis.window = {};
  try {
    assert.equal(GeminiInjected.syncAngularModel(host, 'prompt'), false);
  } finally {
    if (prevWindow !== undefined) globalThis.window = prevWindow;
    else delete globalThis.window;
  }
});

test('MAIN-world typing: syncAngularModel returns true when fake ng with getComponent/applyChanges is provided', () => {
  const host = {};
  let updatedValue = null;
  let appliedComponent = null;

  const mockComponent = {
    formControl: {
      setValue: (v) => { updatedValue = v; }
    }
  };

  const prevWindow = globalThis.window;
  globalThis.window = {
    ng: {
      getComponent: (el) => (el === host ? mockComponent : null),
      applyChanges: (comp) => { appliedComponent = comp; }
    }
  };

  try {
    const synced = GeminiInjected.syncAngularModel(host, 'synced value');
    assert.equal(synced, true);
    assert.equal(updatedValue, 'synced value');
    assert.equal(appliedComponent, mockComponent);
  } finally {
    if (prevWindow !== undefined) globalThis.window = prevWindow;
    else delete globalThis.window;
  }
});

test('MAIN-world typing: findQuillInMainWorld finds Quill on host and editor', () => {
  const mockQuill = { setText: () => {} };
  const hostWithQuill = { __quill: mockQuill };
  const docHost = {
    querySelector: (sel) => (sel === GeminiInjected.PROMPT_EDITOR_SELECTORS.richTextarea ? hostWithQuill : null)
  };
  assert.equal(GeminiInjected.findQuillInMainWorld(docHost), mockQuill);

  const editorWithQuill = { __quill: mockQuill };
  const hostWithoutQuill = {
    __quill: null,
    querySelector: (sel) => (sel === GeminiInjected.PROMPT_EDITOR_SELECTORS.editor ? editorWithQuill : null)
  };
  const docEditor = {
    querySelector: (sel) => (sel === GeminiInjected.PROMPT_EDITOR_SELECTORS.richTextarea ? hostWithoutQuill : null)
  };
  assert.equal(GeminiInjected.findQuillInMainWorld(docEditor), mockQuill);

  assert.equal(GeminiInjected.findQuillInMainWorld(null), null);
});

