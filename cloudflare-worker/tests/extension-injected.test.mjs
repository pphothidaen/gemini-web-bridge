// Unit tests for extension-cloudflare/injected.js (Main World Interceptor & Prompt Typing)
//
// Background: injected.js runs in Chrome's MAIN world to access Quill (__quill)
// and Angular's internal model, which are invisible to the ISOLATED content script.
// Previously, injected.js had no unit tests because it was a side-effecting IIFE
// that threw ReferenceError in Node. This test suite validates its core logic
// against realistic DOM, Quill, and Angular stubs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Injected = require('../../extension-cloudflare/injected.js');

test('injected.js exports all essential MAIN-world helpers', () => {
  const expectedContract = {
    findQuillInMainWorld: 'function',
    syncAngularModel: 'function',
    typePromptInMainWorld: 'function',
    inspectWizGlobalData: 'function',
    broadcastSessionState: 'function',
    matchRecognizedEndpoint: 'function',
    decodeAndSanitizePayload: 'function',
    // KAN-196: string classification + the gated probe's toggle.
    // A length alone cannot attribute a field's change to the notebook, so
    // each sanitized string also carries a shape class.
    STRING_CLASS: 'object',
    classifyString: 'function',
    extractBoundedStructure: 'function',
    handleProbeSet: 'function',
    PROMPT_EDITOR_SELECTORS: 'object'
  };

  // Verify MAIN-world global attachment: in Chrome MAIN world, module.exports is undefined
  // so callers rely on globalThis.GeminiInjected (and the __GeminiBridgeMain alias).
  assert.ok(globalThis.GeminiInjected, 'must attach GeminiInjected to global root in MAIN world');
  assert.equal(globalThis.GeminiInjected, Injected, 'global GeminiInjected must match exported API');
  assert.equal(globalThis.__GeminiBridgeMain, Injected, 'global __GeminiBridgeMain must match exported API');

  // Verify all contract members are present with the expected types on both exports and global
  for (const [name, expectedType] of Object.entries(expectedContract)) {
    assert.equal(
      typeof Injected[name],
      expectedType,
      `Injected.${name} must be exported as ${expectedType}`
    );
    assert.equal(
      typeof globalThis.GeminiInjected[name],
      expectedType,
      `globalThis.GeminiInjected.${name} must be exported as ${expectedType}`
    );
  }

  // Verify the export surface strictly matches the expected contract (no dropped, renamed, or uncontracted exports)
  assert.deepEqual(
    Object.keys(Injected).sort(),
    Object.keys(expectedContract).sort(),
    'exported surface must exactly match the expected contract'
  );
});

test('PROMPT_EDITOR_SELECTORS uses localization-proof selectors', () => {
  const S = Injected.PROMPT_EDITOR_SELECTORS;

  // Realistic DOM tree modeling Gemini's active input area under a non-English locale (e.g. Thai),
  // where UI labels and placeholders are localized but custom element tags, Quill classes,
  // and contenteditable attributes remain invariant.
  const editorEl = {
    tagName: 'DIV',
    className: 'ql-editor ql-blank textarea new-input-ui',
    attributes: {
      class: 'ql-editor ql-blank textarea new-input-ui',
      contenteditable: 'true',
      'aria-label': 'ป้อนข้อความแจ้งเตือนที่นี่',
      placeholder: 'ถาม Gemini'
    },
    children: [],
    getAttribute(name) { return this.attributes[name] ?? null; }
  };

  const richTextareaEl = {
    tagName: 'RICH-TEXTAREA',
    className: '',
    attributes: {},
    children: [editorEl],
    getAttribute(name) { return this.attributes[name] ?? null; }
  };

  const inputAreaEl = {
    tagName: 'INPUT-AREA-V2',
    className: '',
    attributes: {},
    children: [richTextareaEl],
    getAttribute(name) { return this.attributes[name] ?? null; }
  };

  function matchesCompound(el, token) {
    let rest = token.trim();
    if (!rest) return false;
    const tagMatch = rest.match(/^[a-zA-Z0-9_-]+/);
    if (tagMatch) {
      if (el.tagName.toLowerCase() !== tagMatch[0].toLowerCase()) return false;
      rest = rest.slice(tagMatch[0].length);
    }
    while (rest.length > 0) {
      if (rest.startsWith('.')) {
        const clsMatch = rest.match(/^\.([a-zA-Z0-9_-]+)/);
        if (!clsMatch) return false;
        const classes = (el.className || '').split(/\s+/);
        if (!classes.includes(clsMatch[1])) return false;
        rest = rest.slice(clsMatch[0].length);
      } else if (rest.startsWith('[')) {
        const attrMatch = rest.match(/^\[([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/);
        if (!attrMatch) return false;
        const attrName = attrMatch[1];
        const expectedVal = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4];
        const actualVal = el.getAttribute(attrName);
        if (expectedVal !== undefined) {
          if (actualVal !== expectedVal) return false;
        } else {
          if (actualVal === null) return false;
        }
        rest = rest.slice(attrMatch[0].length);
      } else {
        return false;
      }
    }
    return true;
  }

  function findElement(rootNode, selector) {
    const tokens = selector.trim().split(/\s+/);
    if (tokens.length === 0) return null;

    function searchDescendants(node, remainingTokens) {
      const currentToken = remainingTokens[0];
      const isLast = remainingTokens.length === 1;

      for (const child of node.children || []) {
        if (matchesCompound(child, currentToken)) {
          if (isLast) return child;
          const match = searchDescendants(child, remainingTokens.slice(1));
          if (match) return match;
        }
        const deepMatch = searchDescendants(child, remainingTokens);
        if (deepMatch) return deepMatch;
      }
      return null;
    }

    if (matchesCompound(rootNode, tokens[0])) {
      if (tokens.length === 1) return rootNode;
      return searchDescendants(rootNode, tokens.slice(1));
    }
    return searchDescendants(rootNode, tokens);
  }

  const doc = {
    querySelector: (sel) => findElement(inputAreaEl, sel)
  };

  const resolvedHost = doc.querySelector(S.richTextarea);
  assert.ok(resolvedHost, 'S.richTextarea must match the rich-textarea element in the DOM');
  assert.equal(resolvedHost, richTextareaEl, 'S.richTextarea must resolve to richTextareaEl');

  const resolvedEditor = doc.querySelector(S.editor);
  assert.ok(resolvedEditor, 'S.editor must match the contenteditable editor in the DOM');
  assert.equal(resolvedEditor, editorEl, 'S.editor must resolve to editorEl');
  assert.equal(resolvedEditor.getAttribute('contenteditable'), 'true');

  // Must not match an inactive editor where contenteditable is false
  const inactiveEditorEl = {
    ...editorEl,
    attributes: { ...editorEl.attributes, contenteditable: 'false' },
    getAttribute(name) { return this.attributes[name] ?? null; }
  };
  const inactiveDoc = {
    querySelector: (sel) => findElement({
      ...inputAreaEl,
      children: [{ ...richTextareaEl, children: [inactiveEditorEl] }]
    }, sel)
  };
  assert.equal(inactiveDoc.querySelector(S.editor), null, 'S.editor must reject non-editable container');

  // Verify localization-proof: must not rely on language-specific UI text or aria-labels
  assert.ok(!/send|ส่ง|prompt|ข้อความ/i.test(S.editor), 'S.editor must not rely on localized UI text');
  assert.ok(!/aria-label/i.test(S.editor), 'S.editor must not rely on aria-label which changes with UI language');
  assert.ok(!/aria-label/i.test(S.richTextarea), 'S.richTextarea must not rely on aria-label');
});

test('findQuillInMainWorld finds Quill on host or editor', () => {
  const mockQuill = { setText: () => {}, getLength: () => 10 };

  // Case 1: __quill on host
  const hostWithQuill = {
    __quill: mockQuill,
    querySelector: () => null
  };
  const doc1 = {
    querySelector: (sel) => sel === Injected.PROMPT_EDITOR_SELECTORS.richTextarea ? hostWithQuill : null
  };
  assert.equal(Injected.findQuillInMainWorld(doc1), mockQuill);

  // Case 2: __quill on inner editor
  const editorWithQuill = { __quill: mockQuill };
  const hostWithoutQuill = {
    __quill: null,
    querySelector: (sel) => sel === Injected.PROMPT_EDITOR_SELECTORS.editor ? editorWithQuill : null
  };
  const doc2 = {
    querySelector: (sel) => sel === Injected.PROMPT_EDITOR_SELECTORS.richTextarea ? hostWithoutQuill : null
  };
  assert.equal(Injected.findQuillInMainWorld(doc2), mockQuill);

  // Case 3: no Quill anywhere
  const plainHost = {
    __quill: null,
    querySelector: () => ({ __quill: null })
  };
  const doc3 = {
    querySelector: (sel) => sel === Injected.PROMPT_EDITOR_SELECTORS.richTextarea ? plainHost : null
  };
  assert.equal(Injected.findQuillInMainWorld(doc3), null);

  // Case 4: host element missing
  const doc4 = { querySelector: () => null };
  assert.equal(Injected.findQuillInMainWorld(doc4), null);
  assert.equal(Injected.findQuillInMainWorld(null), null);
});

test('syncAngularModel updates Angular FormControl when window.ng is available', () => {
  const host = {};
  let setVal = null;
  let appliedComp = null;

  const mockComp = {
    formControl: {
      setValue: (val) => { setVal = val; }
    }
  };

  globalThis.window = {
    ng: {
      getComponent: (el) => (el === host ? mockComp : null),
      applyChanges: (comp) => { appliedComp = comp; }
    }
  };

  try {
    const ok = Injected.syncAngularModel(host, 'test prompt');
    assert.equal(ok, true);
    assert.equal(setVal, 'test prompt');
    assert.equal(appliedComp, mockComp);
  } finally {
    delete globalThis.window;
  }
});

test('syncAngularModel returns false when window.ng is missing or throws', () => {
  const host = {};
  assert.equal(Injected.syncAngularModel(host, 'test prompt'), false);

  globalThis.window = {
    ng: {
      getComponent: () => { throw new Error('Angular destroyed'); }
    }
  };
  try {
    assert.equal(Injected.syncAngularModel(host, 'test prompt'), false);
  } finally {
    delete globalThis.window;
  }
});

test('typePromptInMainWorld rejects empty prompts', async () => {
  const res1 = await Injected.typePromptInMainWorld('');
  assert.equal(res1.ok, false);
  assert.equal(res1.reason, 'empty_prompt');

  const res2 = await Injected.typePromptInMainWorld('   \n  ');
  assert.equal(res2.ok, false);
  assert.equal(res2.reason, 'empty_prompt');
});

test('typePromptInMainWorld succeeds with Quill and settles cleanly', async () => {
  let quillText = '';
  let quillSource = '';
  let selectionCalls = [];
  let dispatchedEvents = [];

  const mockQuill = {
    setText: (t, src) => { quillText = t; quillSource = src; },
    setSelection: (idx, len, src) => selectionCalls.push({ idx, len, src }),
    getLength: () => quillText.length
  };

  const editorEl = {
    className: 'ql-editor',
    innerText: 'Hello from test',
    textContent: 'Hello from test',
    dispatchEvent: (evt) => dispatchedEvents.push(evt)
  };

  const hostEl = {
    __quill: mockQuill,
    querySelector: (sel) => (sel === Injected.PROMPT_EDITOR_SELECTORS.editor ? editorEl : null)
  };

  const doc = {
    querySelector: (sel) => {
      if (sel === Injected.PROMPT_EDITOR_SELECTORS.richTextarea) return hostEl;
      if (sel === Injected.PROMPT_EDITOR_SELECTORS.editor) return editorEl;
      return null;
    }
  };

  // Polyfill InputEvent if not present in Node
  if (typeof globalThis.InputEvent === 'undefined') {
    globalThis.InputEvent = class InputEvent {
      constructor(type, init) {
        this.type = type;
        this.data = init?.data;
      }
    };
  }

  const outcome = await Injected.typePromptInMainWorld('Hello from test', {
    doc,
    settleMs: 1,
    maxAttempts: 2,
    setT: (fn) => setTimeout(fn, 1)
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.text, 'Hello from test');
  assert.equal(quillText, 'Hello from test');
  assert.equal(quillSource, 'user'); // Must be 'user' to trigger Angular change detection
  assert.ok(selectionCalls.length > 0);
  assert.ok(dispatchedEvents.length > 0);
  assert.equal(outcome.settled, true);
});

test('typePromptInMainWorld detects reverted text (ql-blank) and retries', async () => {
  let attemptsMade = 0;
  const editorEl = {
    get className() {
      // Reverts to ql-blank on every check
      return 'ql-editor ql-blank';
    },
    innerText: '',
    textContent: '',
    dispatchEvent: () => {}
  };

  const mockQuill = {
    setText: () => { attemptsMade++; },
    setSelection: () => {},
    getLength: () => 5
  };

  const hostEl = {
    __quill: mockQuill,
    querySelector: () => editorEl
  };

  const doc = {
    querySelector: (sel) => {
      if (sel === Injected.PROMPT_EDITOR_SELECTORS.richTextarea) return hostEl;
      if (sel === Injected.PROMPT_EDITOR_SELECTORS.editor) return editorEl;
      return null;
    }
  };

  const outcome = await Injected.typePromptInMainWorld('Will be reverted', {
    doc,
    settleMs: 1,
    maxAttempts: 3,
    setT: (fn) => setTimeout(fn, 1)
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'text_reverted_after_settle');
  assert.equal(attemptsMade, 3);
});

test('decodeAndSanitizePayload strips prompt content from StreamGenerate body', () => {
  const rawBody = 'f.req=' + encodeURIComponent(JSON.stringify([
    null,
    JSON.stringify([
      ["Secret sensitive prompt text", 0, null, null, null, null, null, null],
      ["en"],
      ["c_123", "r_456"]
    ])
  ]));

  const sanitized = Injected.decodeAndSanitizePayload(rawBody);
  assert.ok(sanitized);
  assert.equal(sanitized.hasEnvelope, true);
  // Verify user secret text is nowhere in the sanitized structure
  const dumped = JSON.stringify(sanitized);
  assert.ok(!dumped.includes("Secret sensitive prompt text"));
  assert.ok(dumped.includes('"type":"string"'));
});

test('decodeAndSanitizePayload returns null when body has no f.req= envelope', () => {
  // Bodies without f.req= at all — all three null guards in the function overlap;
  // these act as basic sanity assertions but are NOT sufficient to pin the specific guard.
  assert.equal(Injected.decodeAndSanitizePayload('count=1&event=click'), null);
  assert.equal(Injected.decodeAndSanitizePayload('data=somevalue&other=stuff'), null);

  // The mutation-pinning case: a body whose raw string does NOT contain the literal
  // "f.req=" substring (so the guard `if (!bodyStr.includes("f.req=")) return null`
  // must fire), but whose *decoded* URLSearchParams key IS "f.req" with a parseable
  // JSON array value.  The encoded dot trick: `f%2Ereq=<payload>`.
  //
  // - Guard present  → bodyStr.includes("f.req=") is false → returns null ✓
  // - Guard removed  → params.get("f.req") returns the payload → returns non-null ✗
  //
  // This is the only assertion that changes behaviour when the guard is mutated to
  // `if (false) return null`.
  const encodedKeyBody = 'f%2Ereq=' + encodeURIComponent(
    JSON.stringify([null, JSON.stringify([[]])])
  );
  assert.ok(!encodedKeyBody.includes('f.req='), 'precondition: raw body must not contain literal f.req=');
  assert.equal(
    Injected.decodeAndSanitizePayload(encodedKeyBody),
    null,
    'guard must reject body that lacks the literal f.req= envelope'
  );
});

test('matchRecognizedEndpoint recognizes StreamGenerate and rejects other hosts', () => {
  const match = Injected.matchRecognizedEndpoint(
    'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=cfb2h_123'
  );
  assert.ok(match);
  assert.equal(match.endpoint, 'StreamGenerate');
  assert.equal(match.buildLabel, 'cfb2h_123');

  const foreign = Injected.matchRecognizedEndpoint('https://evil.com/_/BardChatUi/data/StreamGenerate');
  assert.equal(foreign, null);
});
