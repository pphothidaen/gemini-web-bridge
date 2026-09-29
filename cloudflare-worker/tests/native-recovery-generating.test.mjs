/**
 * The generating signal, pinned to what was MEASURED rather than assumed.
 *
 * These fixtures are the live DOM, sampled every couple of seconds across one
 * whole generation on 2026-09-29. That distinction is the point of this file,
 * because the previous version was written from an assumption and passed
 * against code that broke production.
 *
 * What went wrong, so it is not repeated. `processing-state-visible` and
 * `has-thoughts` read like "currently processing". They are not - they are
 * permanent. The finished response measured here still carries
 * `class="model-response-text has-thoughts processing-state-visible"`, and a
 * sibling footer reads `response-footer gap has-thoughts complete`. Treating
 * those as a generating signal made isGenerating() return true forever:
 * handleCollectAnswer burned its full 120s budget and failed with
 * collect_answer_timeout on an answer finished for a minute.
 *
 * The tests that shipped with that bug asserted "a finished response with
 * only has-thoughts is inactive" - false, and the stub was built to satisfy
 * it. A test written to match the code is worse than none, because it reads
 * like verification.
 *
 * Every fixture below is transcribed from an observation:
 *
 *   WHILE GENERATING  div.markdown[aria-busy="true"]  present
 *                     structured-content  has-thoughts processing-state-visible
 *                     response-footer     has-thoughts            (no complete)
 *
 *   WHEN FINISHED     no [aria-busy="true"] anywhere
 *                     structured-content  has-thoughts processing-state-visible
 *                     response-footer     has-thoughts complete
 *
 * Only aria-busy and complete differ. Everything else is identical, which is
 * exactly why the class names were the wrong thing to read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const NativeRecovery = require('../../extension-cloudflare/native-recovery.js');

function node(className, attrs = {}, tag = 'div') {
  return { className, attrs, tag };
}

/**
 * A model-response exactly as measured, in one of the two observed states.
 *
 * ariaBusy and footerComplete are the only knobs, because they are the only
 * things that differed. The permanent classes are passed in BOTH states on
 * purpose: that is what makes these tests fail if anyone reintroduces a check
 * on them.
 */
function measuredResponse({ ariaBusy, footerComplete }) {
  return makeResponse([
    node('response-container-content ng-tns-c2808902342-11 has-thoughts'),
    node('model-response-text has-thoughts processing-state-visible ng-star-inserted'),
    node('markdown markdown-main-panel md-content animate enable-luminous-fast-follows',
      { 'aria-busy': ariaBusy ? 'true' : 'false', 'aria-live': 'polite' }),
    node(footerComplete
      ? 'response-footer gap has-thoughts complete'
      : 'response-footer animated gap has-thoughts'),
  ]);
}

function makeResponse(nodes) {
  return {
    _nodes: nodes,
    querySelector(sel) { return this._nodes.find((n) => matches(n, sel)) || null; },
    querySelectorAll(sel) { return this._nodes.filter((n) => matches(n, sel)); },
  };
}

/**
 * Minimal selector matching, covering exactly the forms native-recovery uses:
 * `tag`, `.class`, `tag.class`, `[attr="v"]`, `tag[attr*="v"]` and a
 * comma-separated list of those.
 *
 * Deliberately not a CSS engine — a stub that silently fails to match is how
 * the previous suite ended up asserting things the real selectors never see.
 * Anything unrecognised returns false rather than a hopeful true.
 */
function matches(n, sel) {
  if (sel === '*') return true;
  return String(sel).split(',').map((s) => s.trim()).filter(Boolean).some((one) => matchesOne(n, one));
}

function matchesOne(n, sel) {
  // Split off a trailing attribute test: [attr="v"] or [attr*="v"]
  const attr = sel.match(/\[([\w-]+)([*^$~]?)="?([^"\]]*)"?\]$/);
  let base = sel;
  if (attr) {
    base = sel.slice(0, attr.index).trim();
    const [, name, op, value] = attr;
    const actual = n.attrs?.[name] ?? null;
    if (actual === null) return false;
    if (op === '*') { if (!String(actual).includes(value)) return false; }
    else if (op === '^') { if (!String(actual).startsWith(value)) return false; }
    else if (actual !== value) return false;
  }
  if (!base) return true;                       // attribute-only selector
  if (base.startsWith('.')) return n.className.includes(base.slice(1));
  if (base.includes('.')) {
    const [tag, ...classes] = base.split('.');
    if (n.tag !== tag) return false;
    return classes.every((c) => n.className.includes(c));
  }
  return n.tag === base;                         // bare tag
}

function makeDoc(responses = [], docQs = {}) {
  const all = responses.flatMap((r) => r._nodes);
  return {
    querySelectorAll(sel) {
      if (sel === 'model-response') return responses;
      if (sel === '*') return all;
      return [];
    },
    querySelector(sel) {
      return docQs[sel] || all.find((n) => matches(n, sel)) || null;
    },
  };
}

// ── The measured pair ───────────────────────────────────────────────────────

test('MEASURED: a generating response is active, and a finished one is not', () => {
  // Same response, same permanent classes, two observed states. The only
  // difference is aria-busy — so if this ever fails, the signal changed.
  const generating = measuredResponse({ ariaBusy: true, footerComplete: false });
  const finished = measuredResponse({ ariaBusy: false, footerComplete: true });

  const during = NativeRecovery.generatingSignal(makeDoc([generating]));
  assert.equal(during.active, true, 'the measured mid-generation DOM must read as active');
  assert.equal(during.source, 'response_aria_busy');

  const after = NativeRecovery.generatingSignal(makeDoc([finished]));
  assert.equal(after.active, false,
    'the measured settled DOM must NOT read as active — that is the bug that wedged collect for 120s');
  assert.equal(after.source, 'none');
});

test('REGRESSION: the permanent classes alone must never mean "generating"', () => {
  // The exact shape that shipped in 4.7.13: every class the previous
  // implementation keyed on, on a response that is demonstrably finished.
  const wedged = makeResponse([
    node('response-container-content has-thoughts'),
    node('model-response-text has-thoughts processing-state-visible ng-star-inserted'),
    node('markdown md-content', { 'aria-busy': 'false' }),
    node('response-footer gap has-thoughts complete'),
  ]);

  const out = NativeRecovery.generatingSignal(makeDoc([wedged]));
  assert.equal(out.active, false,
    'has-thoughts / processing-state-visible persist after the answer is done; ' +
    'keying on them wedges every collect until it times out');
});

// ── Scoping ─────────────────────────────────────────────────────────────────

test('an older response mid-generation does not make the newest report active', () => {
  const out = NativeRecovery.generatingSignal(makeDoc([
    measuredResponse({ ariaBusy: true, footerComplete: false }),
    measuredResponse({ ariaBusy: false, footerComplete: true }),
  ]));
  assert.equal(out.active, false, 'scoped to the newest response');
  assert.equal(out.source, 'none');
});

test('the newest response mid-generation is active even with a finished one before it', () => {
  const out = NativeRecovery.generatingSignal(makeDoc([
    measuredResponse({ ariaBusy: false, footerComplete: true }),
    measuredResponse({ ariaBusy: true, footerComplete: false }),
  ]));
  assert.equal(out.active, true);
  assert.equal(out.source, 'response_aria_busy');
});

// ── Pre-existing signals must still work ────────────────────────────────────

test('spinner inside newest response still reports response_spinner', () => {
  const out = NativeRecovery.generatingSignal(makeDoc([makeResponse([node('loading-content-spinner-container', {}, 'div')])]));
  assert.equal(out.active, true);
  assert.equal(out.source, 'response_spinner');
});

test('stop button inside newest response still reports response_stop_button', () => {
  const out = NativeRecovery.generatingSignal(makeDoc([
    makeResponse([node('', { 'aria-label': 'หยุดการสร้าง' }, 'button')]),
  ]));
  assert.equal(out.active, true);
  assert.equal(out.source, 'response_stop_button');
});

test('lottie clipPath still reports lottie_clippath', () => {
  const out = NativeRecovery.generatingSignal(makeDoc([], { 'clipPath[id^="__lottie_element"]': node('', {}, 'clipPath') }));
  assert.equal(out.active, true);
  assert.equal(out.source, 'lottie_clippath');
});

test('a sidenav spinner is rejected', () => {
  const spinner = node('loading-content-spinner-container', {}, 'div');
  spinner.closest = () => ({ tagName: 'BARD-SIDENAV' });
  const doc = {
    querySelectorAll: () => [],
    querySelector: (s) => (String(s).includes('loading-content-spinner') ? spinner : null),
  };
  assert.equal(NativeRecovery.generatingSignal(doc).active, false,
    'the chat-history loader is not a generation signal');
});

// ── Robustness ──────────────────────────────────────────────────────────────

test('a response stub without querySelector does not throw', () => {
  const bare = { querySelectorAll: () => [] };
  const doc = { querySelectorAll: (s) => (s === 'model-response' ? [bare] : []), querySelector: () => null };
  assert.doesNotThrow(() => NativeRecovery.generatingSignal(doc));
  assert.equal(NativeRecovery.generatingSignal(doc).active, false);
});

test('no response at all is not generating', () => {
  const out = NativeRecovery.generatingSignal({ querySelectorAll: () => [], querySelector: () => null });
  assert.equal(out.active, false);
  assert.equal(out.source, 'none');
});
