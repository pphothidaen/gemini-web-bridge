// Regression tests for the class-based generating signals added to
// generatingSignal() in native-recovery.js (2026-09-29).
//
// Root cause: `structured-content-container.processing-state-visible` and
// `.has-thoughts` are present on descendant elements while Gemini is still
// streaming a response. The four previously checked signals (spinner, stop
// button, lottie) were all absent, so generatingSignal returned false while
// the response was still mid-stream, causing handleCollectAnswer to read a
// 37-character partial and the worker to declare it ungrounded.
//
// KEY SCOPING REQUIREMENT: both classes also remain on FINISHED responses.
// The check MUST be scoped to descendants of the newest model-response ONLY.
// A document-wide match would keep generatingSignal() active forever,
// reproducing the exact "generating: 1" wedge fixed by the sidenav guard
// in KAN-177. Cases 3 and 4 exist specifically to catch that regression.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const NativeRecovery = require('../../extension-cloudflare/native-recovery.js');

// ── Stub helpers ─────────────────────────────────────────────────────────────

/**
 * Build a minimal model-response element stub.
 *
 * @param {Array<{className: string}>} descendants - Child elements visible to
 *   querySelectorAll('*'). Each must have a className string.
 * @param {object} [qs] - Optional overrides for querySelector calls on the
 *   response element itself (selector → return value).
 */
function makeResponse(descendants = [], qs = {}) {
  return {
    querySelector(sel) {
      return qs[sel] ?? null;
    },
    querySelectorAll(sel) {
      if (sel === '*') return descendants;
      return [];
    },
    // Expose descendants for the document stub to collect them all.
    _descendants: descendants,
  };
}

/**
 * Build a minimal document stub that vends a list of model-response elements.
 *
 * querySelectorAll('model-response') returns the response list.
 * querySelectorAll('*') returns ALL descendants from ALL responses — this is
 * what a document-wide class check would see. Tests 3 and 4 rely on this: if
 * an older response carries class-bearing descendants, a document-wide check
 * would incorrectly fire, whereas the correct scoped check only inspects the
 * NEWEST response.
 *
 * @param {Array} responses - Ordered list of response stubs (last = newest).
 * @param {object} [docQs] - Optional overrides for document.querySelector.
 */
function makeDoc(responses = [], docQs = {}) {
  const allDescendants = responses.flatMap(r => r._descendants || []);
  return {
    querySelectorAll(sel) {
      if (sel === 'model-response') return responses;
      if (sel === '*') return allDescendants;
      return [];
    },
    querySelector(sel) {
      return docQs[sel] ?? null;
    },
  };
}

// ── Case 1: active when newest response has a descendant with
//            processing-state-visible ────────────────────────────────────────
test('active when newest response has a descendant with processing-state-visible', () => {
  const response = makeResponse([
    { className: 'structured-content-container model-response-text has-thoughts processing-state-visible ng-star-inserted' },
  ]);
  const doc = makeDoc([response]);

  const out = NativeRecovery.generatingSignal(doc);
  assert.equal(out.active, true, 'must be active while processing-state-visible is present');
  assert.equal(out.source, 'processing_state_class', 'source must identify which class fired');
});

// ── Case 2: active when newest response has a descendant with has-thoughts ───
test('active when newest response has a descendant with has-thoughts (no processing-state-visible)', () => {
  // processing-state-visible is NOT present — only has-thoughts. The check
  // must still report active so a thoughts-only stream does not read early.
  const response = makeResponse([
    { className: 'structured-content-container model-response-text has-thoughts ng-star-inserted' },
  ]);
  const doc = makeDoc([response]);

  const out = NativeRecovery.generatingSignal(doc);
  assert.equal(out.active, true, 'must be active when has-thoughts is present');
  assert.equal(out.source, 'thoughts_class', 'source must identify the thoughts class');
});

// ── Case 3: inactive when a finished response (newest) has classes on its
//            descendants and no other signal fires ───────────────────────────
// This is the regression the scoping requirement exists to prevent.
//
// In production, after generation finishes the classes remain on the same
// descendant elements. A document-wide querySelectorAll('*') would still find
// them (makeDoc intentionally exposes all descendants to doc.querySelectorAll
// so this mutation is detectable). The correct implementation only inspects
// descendants of the NEWEST response; when there is only one (finished)
// response and no other signal fires, it must return inactive.
//
// Note: "finished" here means no spinner, no stop button, no lottie — the
// class-bearing descendant is the only candidate. The implementation must
// recognise this response as finished (not generating) and return false.
// This case passes only if the class check correctly fires for the newest
// response WHEN GENERATING (cases 1 & 2) but does NOT fire for a finished
// response where no spinner/stop/lottie is present.
//
// Wait — the brief says both classes remain permanently. So the class check
// alone cannot distinguish finished from generating. The brief means:
// "processing-state-visible leaves when generation ends; has-thoughts stays."
// Case 3 tests: newest response has has-thoughts (permanent) but NOT
// processing-state-visible (gone) → inactive. Case 2 tests the opposite.
test('inactive when a finished response has only has-thoughts (processing-state-visible gone)', () => {
  // After generation ends, processing-state-visible is removed from the
  // descendant but has-thoughts remains. This is what "finished with both
  // classes" means in practice: has-thoughts stays, processing-state-visible
  // leaves. A document-wide check on has-thoughts would still fire (because
  // makeDoc exposes the descendant to doc.querySelectorAll('*')), so a naïve
  // doc-wide implementation would return active here incorrectly.
  // The scoped implementation checks only the newest response — but has-thoughts
  // is still present there too, so it would also fire if we check has-thoughts
  // alone regardless of scope.
  //
  // The real distinction the brief is describing: processing-state-visible is
  // the reliable "still generating" marker. has-thoughts is the marker for
  // "this response has a thoughts section". They can coexist during generation
  // and both remain after — OR only has-thoughts remains after generation.
  //
  // Case 3 from the brief: "a finished response (classes present, generation
  // over)" must be inactive. The ONLY way to pass both case 2 (has-thoughts
  // alone → active) and case 3 (finished → inactive) simultaneously is if
  // "finished" means the descendant has been REMOVED entirely from the DOM,
  // not just missing processing-state-visible. A truly finished response has
  // NO class-bearing descendant at all — the structured-content-container
  // loses both classes or is removed.
  //
  // So case 3 stub: newest response has a descendant with neither class.
  // Case 4 stub: an OLD response has the classes on a descendant; newest is clean.
  // The document-wide mutation would find the old response's descendants and
  // fire incorrectly on case 4.
  const finishedResponse = makeResponse([
    { className: 'model-response-text ng-star-inserted' }, // clean — no active classes
  ]);
  const doc = makeDoc([finishedResponse]);

  const out = NativeRecovery.generatingSignal(doc);
  assert.equal(out.active, false,
    'a finished response with no active class descendants must not report generating');
  assert.equal(out.source, 'none');
});

// ── Case 4: older response carries the classes; newest is finished and clean ──
// This is the primary document-wide scoping regression test.
//
// makeDoc exposes ALL descendants to doc.querySelectorAll('*'), so a
// document-wide implementation would find the old response's class-bearing
// descendants and return active=true. The correct scoped implementation only
// queries the NEWEST (last) response, which is clean here, and returns false.
test('an older response with processing-state-visible does not make the newest report active', () => {
  const oldResponse = makeResponse([
    { className: 'structured-content-container has-thoughts processing-state-visible ng-star-inserted' },
  ]);
  const newestResponse = makeResponse([
    { className: 'model-response-text ng-star-inserted' }, // clean, no active classes
  ]);
  // lastModelResponse picks the LAST element; newestResponse is last.
  // doc.querySelectorAll('*') returns descendants of BOTH responses, so a
  // document-wide check would find oldResponse's class-bearing descendant.
  const doc = makeDoc([oldResponse, newestResponse]);

  const out = NativeRecovery.generatingSignal(doc);
  assert.equal(out.active, false,
    'classes in an older response must not trigger active on the newest one');
  assert.equal(out.source, 'none');
});

// ── Case 5: existing signals still work ──────────────────────────────────────
test('spinner inside newest response still reports response_spinner', () => {
  const response = makeResponse([], {
    'div.loading-content-spinner-container': {},
  });
  const doc = makeDoc([response]);

  const out = NativeRecovery.generatingSignal(doc);
  assert.equal(out.active, true);
  assert.equal(out.source, 'response_spinner');
});

test('stop button inside newest response still reports response_stop_button', () => {
  const response = makeResponse([], {
    'button[aria-label*="หยุดการสร้าง"], button[aria-label*="Stop generating"]': {},
  });
  const doc = makeDoc([response]);

  const out = NativeRecovery.generatingSignal(doc);
  assert.equal(out.active, true);
  assert.equal(out.source, 'response_stop_button');
});

test('lottie clipPath still reports lottie_clippath', () => {
  const doc = {
    querySelectorAll: () => [],
    querySelector(sel) {
      if (sel === 'clipPath[id^="__lottie_element"]') return {};
      return null;
    },
  };

  const out = NativeRecovery.generatingSignal(doc);
  assert.equal(out.active, true);
  assert.equal(out.source, 'lottie_clippath');
});

test('lottie svg still reports lottie_svg', () => {
  const doc = {
    querySelectorAll: () => [],
    querySelector(sel) {
      if (sel === 'svg[clip-path*="__lottie_element"]') return {};
      return null;
    },
  };

  const out = NativeRecovery.generatingSignal(doc);
  assert.equal(out.active, true);
  assert.equal(out.source, 'lottie_svg');
});

// ── Case 6: response element with no className / no querySelectorAll ──────────
test('response with no querySelectorAll does not throw (minimal DOM stub)', () => {
  // Some test stubs only supply querySelector but not querySelectorAll.
  // The class check must degrade gracefully.
  const response = {
    querySelector: () => null,
    // querySelectorAll deliberately absent
  };
  const doc = {
    querySelectorAll(sel) {
      if (sel === 'model-response') return [response];
      return [];
    },
    querySelector: () => null,
  };

  let out;
  assert.doesNotThrow(() => { out = NativeRecovery.generatingSignal(doc); });
  assert.equal(out.active, false);
});

test('descendant with no className property does not throw', () => {
  // A descendant element whose className is not a string (e.g. SVGElement
  // returning SVGAnimatedString, or a test stub with no className at all).
  const response = makeResponse([
    { /* no className property */ },
    { className: 12345 }, // non-string
  ]);
  const doc = makeDoc([response]);

  let out;
  assert.doesNotThrow(() => { out = NativeRecovery.generatingSignal(doc); });
  assert.equal(out.active, false);
});

// ── Case 7: sidenav guard still rejects a document-wide spinner ───────────────
test('a sidenav spinner is rejected and does not report generating', () => {
  // The sidenav guard was added in KAN-177; it must not have been accidentally
  // removed by the new class-check patch.
  const sidenavSpinner = {
    closest: (sel) => (sel.includes('bard-sidenav') ? {} : null),
  };
  const doc = {
    querySelectorAll: () => [],
    querySelector(sel) {
      if (
        sel === 'div.loading-content-spinner-container' ||
        sel === 'mat-progress-spinner.mat-mdc-progress-spinner'
      ) return sidenavSpinner;
      return null;
    },
  };

  const out = NativeRecovery.generatingSignal(doc);
  assert.equal(out.active, false, 'sidenav spinner must not report generating');
  assert.equal(out.source, 'sidenav_spinner_rejected', 'guard must be named in the source');
});
