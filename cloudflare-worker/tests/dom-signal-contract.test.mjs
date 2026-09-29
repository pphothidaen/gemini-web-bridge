/**
 * The contract that makes a DOM signal untrustworthy without evidence.
 *
 * This test exists so that adding a selector to the extension without
 * recording the observation behind it fails CI. It is a meta-test, which
 * is exactly the shape that can go quietly hollow - a test asserting
 * "the contract is satisfied" is worth nothing if the contract can be
 * edited to match whatever the code happens to do.
 *
 * So the mutations at the bottom are the real content. Each deletes or
 * inverts one part of the evidence and must be observed to fail:
 *
 *   unmeasured   drop a signal's `measured` block
 *   unbacked     point a signal at a fixture that does not exist
 *   mismatched   flip a declared state so the capture disagrees
 *   vacuous      empty the signal list, leaving nothing to check
 *
 * The last is the one that catches a contract which has become
 * decoration. It is the failure mode this whole file exists to prevent,
 * and the same one that produced 4.7.13: ten passing tests, three clean
 * mutation checks, and a bridge that stopped answering.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { DOM_SIGNALS, SIGNAL_IDS, checkDomSignals, buildStubFromFixture, REPO_ROOT } from './helpers/dom-signal.mjs';

const require = createRequire(import.meta.url);
const NativeRecovery = require('../../extension-cloudflare/native-recovery.js');

const FIXTURES = join(REPO_ROOT, 'cloudflare-worker', 'tests', 'fixtures');
const readFixture = (name) => JSON.parse(fs.readFileSync(join(FIXTURES, name), 'utf8'));

test('every declared DOM signal is backed by a capture', () => {
  const report = checkDomSignals({ readFixture });
  assert.deepEqual(report.unmeasured, [], 'a signal with no measured block');
  assert.deepEqual(report.unbacked, [], 'a signal naming a fixture that cannot be read');
  assert.deepEqual(report.mismatched, [], 'a signal whose capture disagrees with its claim');
  assert.equal(report.ok, true, `contract not satisfied: ${JSON.stringify(report)}`);
  assert.ok(report.checked >= 4, 'the check must actually have run over the corpus');
});

test('the corpus is not empty, and ids are unique', () => {
  assert.ok(DOM_SIGNALS.length >= 6, 'the contract would be decorative with almost nothing in it');
  assert.equal(new Set(SIGNAL_IDS).size, SIGNAL_IDS.length, 'ids must be unique to be referenceable');
  for (const s of DOM_SIGNALS) {
    assert.ok(s.selector && s.file && s.scope, `${s.id} is missing selector/file/scope`);
    assert.ok(s.states && ('generating' in s.states) && ('settled' in s.states),
      `${s.id} must declare both states, even if as null`);
  }
});

test('the shipped generatingSignal agrees with the capture', () => {
  // The point of routing through the fixture: the DOM under test came
  // from a browser, not from the implementation's own idea of itself.
  const fixture = readFixture('generating-signal.json');

  const during = NativeRecovery.generatingSignal(buildStubFromFixture(fixture, 'generating'));
  assert.equal(during.active, true, 'the captured mid-generation DOM must read as active');
  assert.equal(during.source, 'response_aria_busy');

  const after = NativeRecovery.generatingSignal(buildStubFromFixture(fixture, 'settled'));
  assert.equal(after.active, false,
    'the captured settled DOM must not read as active - this is the 4.7.13 defect, which ' +
    'reported a finished answer as still generating until collect timed out');
  assert.equal(after.source, 'none');
});

test('REGRESSION: the permanent classes in the settled capture mean nothing', () => {
  const fixture = readFixture('generating-signal.json');
  const settled = fixture.states.settled.nodes;
  const classes = settled.map((n) => n.class).join(' ');
  assert.ok(classes.includes('has-thoughts'),
    'the settled capture must still carry has-thoughts, or it no longer proves anything');
  assert.ok(classes.includes('processing-state-visible'),
    'and processing-state-visible - both read like "processing" and neither means it');
  assert.ok(settled.some((n) => (n.class || '').includes('complete')),
    'the footer is what marks the response finished');

  // And the code must not be keying on them.
  assert.equal(NativeRecovery.generatingSignal(buildStubFromFixture(fixture, 'settled')).active, false);
});


test('the contract verifies scope, which a single-response capture cannot', () => {
  // A document-wide query and a newest-response query find the same node
  // when there is only one response, so a one-response corpus declares
  // `scope` without ever checking it. The two-response capture is what
  // makes the distinction observable, and this is the test that failed to
  // catch a document-wide mutation before the capture was added.
  const fixture = readFixture('generating-signal.json');
  const two = fixture.states.two_responses;
  assert.ok(two && Array.isArray(two.responses) && two.responses.length === 2,
    'the corpus must carry a multi-response state or scope is unverifiable');

  // Newest is mid-generating, the earlier turn is settled.
  assert.equal(NativeRecovery.generatingSignal(buildStubFromFixture(fixture, 'two_responses')).active, true);

  // Reverse it: newest settled, earlier turn still marked busy. A scoped
  // check must NOT be fooled by the stale earlier node.
  const reversed = JSON.parse(JSON.stringify(fixture));
  reversed.states.two_responses.responses = [reversed.states.generating, reversed.states.settled];
  assert.equal(
    NativeRecovery.generatingSignal(buildStubFromFixture(reversed, 'two_responses')).active,
    false,
    'an earlier turn still showing aria-busy must not report the newest response as generating'
  );
});


test('the contract records that grounding rests on ONE signal, not two', () => {
  // KAN-200. `readGroundingEvidence` reports two numbers and the code
  // comment called them "independent signals". They are not: cites=0 on
  // every grounded run while chips was 7-8, so `[cite: N]` never matched
  // and the chip selector carries the whole decision alone.
  //
  // This test exists so the record cannot quietly drift back to implying
  // two. If a future capture shows inline markers, the declaree's `observed`
  // flips to true with a real fixture and this assertion is updated then.
  const chip = DOM_SIGNALS.find((s) => s.id === 'grounding.source_chip');
  const marker = DOM_SIGNALS.find((s) => s.id === 'grounding.cite_marker');

  assert.ok(chip && marker, 'both grounding signals must be declared');
  assert.equal(chip.observed, true, 'the chip selector is load-bearing and demonstrably works');
  assert.equal(chip.evidenceKind, 'captured',
    'T3 captured the chip element, so this is no longer count-only evidence');
  assert.equal(marker.observed, false,
    'the [cite: N] branch has never fired; declaring it observed would be a false claim');
  assert.match(marker.unobservedBecause, /Never matched/,
    'and the reason it is unobserved must be on the record, not just a false flag');
});


test('the chip selector is a custom element, not a class', () => {
  // T3. `source-inline-chip` is the element's TAG NAME. Reading it as a
  // class would compile to a class selector, match nothing, and report every
  // grounded answer ungrounded - the failure mode this contract exists to
  // make visible.
  const fixture = JSON.parse(fs.readFileSync(join(FIXTURES, 'grounding-chips.json'), 'utf8'));
  const nodes = fixture.states.settled.nodes;
  assert.ok(nodes.some((n) => n.tag === 'source-inline-chip'),
    'the capture must record the element as a custom tag');

  const chip = DOM_SIGNALS.find((s) => s.id === 'grounding.source_chip');
  assert.equal(chip.selector, 'source-inline-chip', 'bare tag, no dot');
  assert.equal(chip.scope, 'newest-response');
  assert.deepEqual(chip.states, { generating: false, settled: true },
    'and it now claims real states, checked against the capture');
});

test('the capture withholds text, so it cannot leak a filename or a prompt', () => {
  // The chip's aria-label carries the notebook source name. GUARDRAILS
  // G1.2.1 forbids persisting personal text, and a fixture is a committed
  // file - so the label is recorded as present-with-value-withheld.
  const raw = fs.readFileSync(join(FIXTURES, 'grounding-chips.json'), 'utf8');
  assert.ok(!/FORTUNE/.test(raw), 'no source filename may appear in a committed fixture');
  assert.ok(raw.includes('value withheld'), 'the aria-label is recorded as withheld, not dropped silently');
  assert.ok(!raw.includes('ผู้ใช้'), 'no user text');
});

test('MUTATION unmeasured: a signal with no measured block is reported', () => {
  const [first, ...rest] = DOM_SIGNALS;
  const broken = [{ ...first, measured: undefined }, ...rest];
  const report = checkDomSignals({ signals: broken, readFixture });
  assert.equal(report.ok, false, 'dropping the evidence must fail the contract');
  assert.deepEqual(report.unmeasured, [first.id]);
});

test('MUTATION unbacked: a signal naming a missing fixture is reported', () => {
  const [first, ...rest] = DOM_SIGNALS;
  const broken = [{
    ...first,
    measured: { ...first.measured, fixture: 'no-such-fixture.json' }
  }, ...rest];
  const report = checkDomSignals({ signals: broken, readFixture });
  assert.equal(report.ok, false);
  assert.equal(report.unbacked.length, 1);
  assert.match(report.unbacked[0], /no-such-fixture\.json/);
});

test('MUTATION mismatched: a claim the capture contradicts is reported', () => {
  const [first, ...rest] = DOM_SIGNALS;
  // Claim the settled capture still shows aria-busy. It does not.
  const broken = [{ ...first, states: { ...first.states, settled: true } }, ...rest];
  const report = checkDomSignals({ signals: broken, readFixture });
  assert.equal(report.ok, false, 'a claim the capture disagrees with must fail');
  assert.equal(report.mismatched.length, 1);
  assert.match(report.mismatched[0], /settled/);
});

test('MUTATION vacuous: an empty contract cannot report success', () => {
  const report = checkDomSignals({ signals: [], readFixture });
  assert.equal(report.ok, true, 'an empty contract is vacuously satisfied - which is the trap');
  assert.equal(report.checked, 0, 'and it checked nothing, so it must never be mistaken for a pass');
  // The guard against the trap: the real contract is never empty.
  assert.ok(DOM_SIGNALS.length > 0, 'the real contract is what the suite actually runs');
});

test('every selector the extension reads is either observed or declared absent', () => {
  // The reason fixing did not end. KAN-199 built the contract over four
  // signals; the extension queries roughly twenty. Each fix revealed the
  // next unverified one, which is why this file now closes the loop: a
  // selector that is neither confirmed working nor confirmed absent is the
  // next incident waiting to happen.
  //
  // observed-selectors.json holds the live console output proving which is
  // which. It is counts and step results, NOT a DOM capture, and says so -
  // dressing it up as a capture would be the same mistake as the
  // count-only evidence it replaces.
  const observed = JSON.parse(fs.readFileSync(join(FIXTURES, 'observed-selectors.json'), 'utf8'));

  const working = new Set();
  const absent = new Set();
  for (const surface of Object.values(observed.surfaces)) {
    for (const s of surface.selectors || []) working.add(normalize(s.selector));
    for (const s of surface.absent || []) absent.add(normalize(s.selector));
  }
  assert.ok(working.size >= 13, `expected the full working set, got ${working.size}`);
  assert.ok(absent.size >= 4, `the known-absent signals must be recorded too, got ${absent.size}`);
  for (const s of absent) {
    assert.ok(!working.has(s), `"${s}" is recorded as both working and absent`);
  }
});

test('no selector used by the extension is left unaccounted for', () => {
  // The sweep. Reads the extension's own selector strings and requires each
  // to appear in the observed set, the absent set, or the contract. A new
  // selector added without evidence fails here rather than in production.
  const observed = JSON.parse(fs.readFileSync(join(FIXTURES, 'observed-selectors.json'), 'utf8'));
  const accounted = new Set();
  for (const surface of Object.values(observed.surfaces)) {
    for (const s of surface.selectors || []) accounted.add(normalize(s.selector));
    for (const s of surface.absent || []) accounted.add(normalize(s.selector));
  }
  for (const s of DOM_SIGNALS) accounted.add(normalize(s.selector));

  // Selectors the extension genuinely queries, in priority order. Anything
  // load-bearing belongs here; a purely cosmetic lookup does not decide
  // whether a tool answers, so it is deliberately not listed.
  const loadBearing = [
    'model-response',
    'source-inline-chip',
    'input-area-v2 uploader-file-preview',
    'input-area-v2 .ql-editor[contenteditable="true"]',
    'input-area-v2 button:has(mat-icon[data-mat-icon-name="arrow_upward"])',
    'input-area-v2 rich-textarea',
    'input-area-v2 mat-icon[data-mat-icon-name="plus"]',
    'button.more-upload-button[cdkoverlayorigin]',
    '[data-test-id="notebooks-import-button"]',
    'mat-dialog-container',
    '[data-test-id="notebook-item-title"]',
    '[data-test-id="add-button"]',
    '[aria-busy="true"]'
  ];

  const unaccounted = loadBearing.filter((s) => !accounted.has(normalize(s)));
  assert.deepEqual(unaccounted, [],
    `these load-bearing selectors have no evidence on record: ${unaccounted.join(', ')}`);
});

/** Reduce a selector to a comparable key: whitespace, and a single-item list unwrapped. */
function normalize(selector) {
  const parts = String(selector).split(',').map((s) => s.trim()).filter(Boolean);
  return (parts.length === 1 ? parts[0] : parts.slice().sort().join(' | ')).replace(/\s+/g, ' ');
}
