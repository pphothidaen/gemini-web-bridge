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
  assert.equal(typeof Injected.findQuillInMainWorld, 'function');
  assert.equal(typeof Injected.syncAngularModel, 'function');
  assert.equal(typeof Injected.typePromptInMainWorld, 'function');
  assert.equal(typeof Injected.inspectWizGlobalData, 'function');
  assert.equal(typeof Injected.broadcastSessionState, 'function');
  assert.equal(typeof Injected.matchRecognizedEndpoint, 'function');
  assert.equal(typeof Injected.decodeAndSanitizePayload, 'function');
  assert.ok(Injected.PROMPT_EDITOR_SELECTORS);
});

test('PROMPT_EDITOR_SELECTORS uses localization-proof selectors', () => {
  const S = Injected.PROMPT_EDITOR_SELECTORS;
  assert.equal(S.richTextarea, 'input-area-v2 rich-textarea');
  assert.equal(S.editor, 'input-area-v2 .ql-editor[contenteditable="true"]');
  assert.ok(!S.editor.includes('ส่ง'));
  assert.ok(!S.editor.toLowerCase().includes('send'));
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
