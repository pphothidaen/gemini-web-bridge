/**
 * KAN-236 Phase D: the payload-capture relay puts conversation metadata onto an
 * HTTP endpoint, a new place for it to leak from. These tests make that boundary
 * checkable rather than asserted.
 *
 * The property under test is NOT "the relay scrubs things" — it never scrubs,
 * because there is nothing to scrub. The extension ships exactly what
 * `extractBoundedStructure` produced, and that emits only `{kind, length, cls}`
 * per node. So both ends are checked:
 *
 *   1. the producer emits no text at all, and
 *   2. the consumer does not widen or re-log what it was given.
 *
 * A test that only checked (1) would pass even if the worker re-serialised the
 * record into an error message or a log line. One that only checked (2) would
 * pass even if the extension were handed the raw body. Both are load-bearing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Injected = require('../../extension-cloudflare/injected.js');
const {
  extractBoundedStructure,
  decodeAndSanitizePayload,
  armPayloadCapture,
  isPayloadCaptureArmed,
  emitProbeRecord
} = Injected;

const WORKER_SOURCE = fs.readFileSync(
  new URL('../src/index.js', import.meta.url).pathname,
  'utf8'
);

// Distinctive substrings. If any of these appears in a serialized record, the
// boundary has been crossed.
const PROMPT_MARKERS = [
  'SENTINEL_PROMPT_ALPHA',
  'SENTINEL_PROMPT_BETA',
  'zaphod-two-heads'
];

function buildFakePayload(prompt) {
  // Shape copied from the real StreamGenerate envelope: outer [null, innerJSON],
  // innerJSON an array whose [0] is the prompt.
  const inner = [
    [prompt, 0, null, null, null, null, 0],
    ['th'],
    [null, null, null, null, null, []]
  ];
  return [null, JSON.stringify(inner)];
}

test('the record the relay would ship contains no prompt text', () => {
  const prompt = PROMPT_MARKERS.join(' ');
  const sanitized = decodeAndSanitizePayload(buildFakePayload(prompt));
  const dumped = JSON.stringify(sanitized);
  for (const marker of PROMPT_MARKERS) {
    assert.ok(
      !dumped.includes(marker),
      `the sanitized record leaked prompt text (${marker}). The relay depends on ` +
      'extractBoundedStructure being total, not best-effort.'
    );
  }
});

test('extractBoundedStructure replaces every string VALUE, keeping only structure', () => {
  // The invariant is not "no unexpected keys" — object keys are part of the
  // shape and are deliberately preserved (a payload's field names are exactly
  // what Phase D is trying to learn). The invariant is that no string *value*
  // survives: each one becomes {type, length, cls}.
  //
  // An earlier version of this test asserted a key allowlist and failed on `k`,
  // which was the test being wrong rather than the code: `k` is a field name,
  // and the sanitiser is right to keep it.
  const SECRET = 'a-secret-value';
  const out = extractBoundedStructure([[SECRET, 7, null], { k: 'another' }]);
  const dumped = JSON.stringify(out);
  assert.ok(!dumped.includes(SECRET), 'a string value must not survive');
  assert.ok(!dumped.includes('"another"'), 'nor any other string value');

  // Every string the producer emitted must have become a sanitized node, and
  // that node must carry the original length so the measurement can still use
  // it. This is the whole point: length without content.
  let sawStringNode = false;
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      if (node.type === 'string') {
        sawStringNode = true;
        assert.equal(typeof node.length, 'number', 'a string node must keep its length');
        assert.equal(typeof node.cls, 'string', 'a string node must be classified');
      }
      for (const v of Object.values(node)) walk(v);
    }
  })(out);
  assert.ok(sawStringNode, 'the sanitiser must actually produce string nodes');
});

/** Drive the module's `window` reference without touching a real one. */

test('the relay is DISARMED on load, before anything is asked for', () => {
  // Read the flag without setting it. The previous version of this test called
  // armPayloadCapture(false) and then asserted the relay was quiet — which
  // passed even with the default flipped to true, because it never looked at
  // the default. Caught by mutation, not by review.
  //
  // Must run before any other test in this file touches the flag, hence the
  // explicit re-arm/disarm normalisation afterwards rather than relying on
  // file order alone.
  assert.equal(isPayloadCaptureArmed(), false,
    'the relay must be OFF on load; if arming were implicit, every call in ' +
    'normal operation would ship conversation metadata');
  armPayloadCapture(false);
});

test('a disarmed relay emits nothing, however tempting the record', () => {
  withFakeWindow((posted) => {
    armPayloadCapture(false);
    emitProbeRecord({ structure: [{ index: 0, kind: 'string', length: 3 }] });
    assert.equal(posted.length, 0,
      'a disarmed relay must not post anything');
  });
});

test('an armed relay posts once, under the tag the content script trusts', () => {
  withFakeWindow((posted) => {
    assert.equal(armPayloadCapture(true), true);
    emitProbeRecord({ structure: [{ index: 0, kind: 'string', length: 3 }] });
    assert.equal(posted.length, 1, 'an armed relay posts exactly once');
    assert.equal(posted[0].source, 'GEMINI_INJECTED',
      'the content script only trusts GEMINI_INJECTED; another tag is dropped');
    assert.equal(posted[0].type, 'PAYLOAD_CAPTURE');
  });
});

test('the worker drops captures unless armed, and bounds the buffer', () => {
  assert.match(WORKER_SOURCE, /if \(!this\.payloadCaptureArmed\) \{/,
    'an unarmed capture must be dropped at the worker, not merely never requested');
  assert.match(WORKER_SOURCE, /PAYLOAD_CAPTURE_MAX = \d+;/,
    'the buffer must be bounded — unbounded is a slow leak of conversation metadata');
  assert.match(WORKER_SOURCE,
    /while \(this\.payloadCaptures\.length > PAYLOAD_CAPTURE_MAX\) \{\s*this\.payloadCaptures\.shift\(\);/,
    'the cap must actually evict, not merely be declared');
});

test('the capture endpoint is authenticated, and NOT on the public /health', () => {
  // Measured: an unauthenticated GET to /health returns 200. Anything readable
  // from there is world-readable, so conversation metadata must not go there —
  // even though /health is where the heartbeat block already lives, and even
  // though the brief for this work said "/health".
  const pub = WORKER_SOURCE.match(/const publicPaths = \[[^\]]*\];/)[0];
  assert.ok(!pub.includes('payload-capture'),
    '/debug/payload-capture must not be added to publicPaths');
  assert.match(WORKER_SOURCE, /url\.pathname === "\/debug\/payload-capture"/,
    'the endpoint must live at a non-public path so the generic auth gate covers it');
});

test('the worker never logs the capture record itself', () => {
  // The console sink is deliberately silent unless the probe flag is set. The
  // new path must not become a logging path: DO logs persist, and so would any
  // error response built from the record.
  const handler = WORKER_SOURCE.slice(
    WORKER_SOURCE.indexOf('} else if (msg.type === "PAYLOAD_CAPTURE") {'),
    WORKER_SOURCE.indexOf('} else if (msg.requestId && this.activeStreams.has(msg.requestId)) {')
  );
  assert.ok(handler.length > 0, 'the PAYLOAD_CAPTURE branch must exist');
  assert.ok(!/console\.\w+\([^)]*record/.test(handler),
    'no console call in the capture handler may receive the record');
});

test('arming clears previous captures so cases cannot bleed together', () => {
  // chip-present / chip-absent / chip-repeat are compared against each other. A
  // leftover record from the previous case would silently corrupt exactly the
  // comparison Phase D exists to make.
  assert.match(WORKER_SOURCE, /if \(armed\) this\.payloadCaptures = \[\];/,
    'arming must clear the buffer, or a new case can read the previous one');
});

test('the arm travels BOTH ways, not just the record', () => {
  // Shipped broken, and only production caught it. The relay is two hops in
  // opposite directions:
  //
  //   down: worker -> background -> content.js -> page   (arm)
  //   up:   page -> content.js -> background -> worker   (record)
  //
  // The upward relay was wired and the downward forward was not, so POST
  // returned {"armed":true}, the DO flag flipped, and nothing was ever
  // captured. Half a chain looks exactly like a working chain in a diff, and
  // the endpoint reporting success made it worse — the failure was a lie of
  // omission, not an error.
  //
  // Both directions are now asserted, so a future edit to one cannot silently
  // leave the other behind.
  const bg = fs.readFileSync(
    new URL('../../extension-cloudflare/background.js', import.meta.url).pathname,
    'utf8'
  );
  const content = fs.readFileSync(
    new URL('../../extension-cloudflare/content.js', import.meta.url).pathname,
    'utf8'
  );
  const injected = fs.readFileSync(
    new URL('../../extension-cloudflare/injected.js', import.meta.url).pathname,
    'utf8'
  );

  // Downward: the arm must be in the forward-to-active-tab group, not merely
  // mentioned somewhere in the file.
  const downGroup = bg.slice(
    bg.indexOf('case "PREPARE_MODEL":'),
    bg.indexOf('break;', bg.indexOf('case "PREPARE_MODEL":'))
  );
  assert.match(downGroup, /case "PAYLOAD_CAPTURE_ARM"/,
    'the arm must be in the forwardToActiveTab group or it stops at the background');
  assert.match(downGroup, /forwardToActiveTab\(msg\)/);

  // Downward, rest of the hop.
  assert.match(content, /case "PAYLOAD_CAPTURE_ARM":\s*handlePayloadCaptureArm\(msg\);/,
    'content.js must dispatch the arm');
  assert.match(content, /type: "PAYLOAD_CAPTURE_ARM"/,
    'content.js must post the arm into the page');
  assert.match(injected, /type === "PAYLOAD_CAPTURE_ARM"/,
    'injected.js must accept the arm');
  assert.match(injected, /armPayloadCapture\(event\.data\.armed === true\)/,
    'injected.js must apply it, and only for an explicit boolean');

  assert.match(content, /case "PAYLOAD_CAPTURE":\s*sendToWorker\(\{ type: "PAYLOAD_CAPTURE"/,
    'content.js must relay the record to the background');
  // Upward, rest of the hop. Slice the whole array literal rather than guessing
  // at offsets: PAYLOAD_CAPTURE is appended AFTER "GROUNDING_RESULT", so a
  // slice ending at that name cuts the very entry off.
  // ending at that name cuts the very entry off.
  const upStart = bg.indexOf('["STREAM_CHUNK"');
  const upGroup = bg.slice(upStart, bg.indexOf('.includes(', upStart));
  assert.ok(upStart > 0, 'the upward relay list must exist');
  assert.match(upGroup, /"PAYLOAD_CAPTURE"/,
    'background.js must forward the record to the worker');
  assert.match(injected, /source: "GEMINI_INJECTED",\s*type: "PAYLOAD_CAPTURE"/,
    'the page must tag the record with the source content.js trusts');
});

function withFakeWindow(fn) {
  const posted = [];
  const had = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    value: { postMessage: (msg) => posted.push(msg) },
    configurable: true,
    writable: true
  });
  try {
    return fn(posted);
  } finally {
    if (had) Object.defineProperty(globalThis, 'window', had);
    else delete globalThis.window;
    armPayloadCapture(false);
  }
}
