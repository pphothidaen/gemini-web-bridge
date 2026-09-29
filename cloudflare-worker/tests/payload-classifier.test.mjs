/**
 * A sanitized payload must be able to say what SHAPE a field holds, not just
 * how long it is — without ever keeping the field's content.
 *
 * The problem this solves. After KAN-195, two StreamGenerate structures were
 * captured: one from a grounded answer, one from an ungrounded one. They
 * differed in a single top-level field, and only in its length. That cannot be
 * acted on, because two different values can share a length — "field 3 changed
 * size" is equally consistent with a notebook reference having appeared, having
 * vanished, or never having been there and something else of similar length
 * taking its place. The samples were correct and still uninformative.
 *
 * So each sanitized string now also carries a class drawn from a closed set of
 * protocol shapes. The question being answered is not "what does field 3
 * contain" but "does any field carry a notebook reference at all" — one bit per
 * field, decided by the protocol rather than by the person typing.
 *
 * The safety argument, and the test that checks it. Only a fixed prefix
 * allowlist is consulted: notebook://, http(s)://, a bare UUID, boq_, or a
 * string that parses as JSON. A user's prompt matches none of them, so it
 * lands in OPAQUE with nothing retained. The canary test below is what makes
 * that checkable rather than asserted — it fails the moment anyone adds a
 * prefix, a substring, a hash or a first-N to the output, which is the only
 * way this could start leaking.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Injected = require('../../extension-cloudflare/injected.js');
const { STRING_CLASS: C, classifyString, extractBoundedStructure, decodeAndSanitizePayload } = Injected;

/** Collect every sanitized-string node in a structure. */
function stringNodes(node, out = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => stringNodes(n, out));
  } else if (node && typeof node === 'object') {
    if (node.type === 'string') out.push(node);
    Object.values(node).forEach((n) => stringNodes(n, out));
  }
  return out;
}

test('classifyString names the protocol shapes that matter', () => {
  assert.equal(
    classifyString('notebook://notebooks/b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0/sources/9f2c-uuid'),
    C.NOTEBOOK_REF,
    'a notebook reference is the one class this whole exercise exists to find'
  );
  assert.equal(classifyString('https://gemini.google.com/app'), C.URL);
  assert.equal(classifyString('http://example.test/x'), C.URL);
  assert.equal(classifyString('9f2c1b7a-4e3d-4a1b-8c2e-5d6f7a8b9c0d'), C.UUID);
  assert.equal(classifyString('boq_gemini-web-uiserver_20260928.01_p0'), C.BUILD_LABEL);
  assert.equal(classifyString('[["prompt",0,null]]'), C.JSON_BLOB);
  assert.equal(classifyString('{"a":1}'), C.JSON_BLOB);
});

test('classifyString files a prompt as opaque, not as a protocol shape', () => {
  // The misfiling that matters: a prompt opening with "[" must not be read as
  // a serialized blob, because that would both be wrong and would hide the
  // one class the comparison depends on.
  assert.equal(classifyString('[นี่คือพรอมต์ของผู้ใช้ ไม่ใช่ JSON'), C.OPAQUE);
  assert.equal(classifyString('สรุปสั้น ๆ ว่า BaZi คำนวณอย่างไร'), C.OPAQUE);
  assert.equal(classifyString('notebook:// about the topic, in prose'), C.NOTEBOOK_REF,
    'the scheme alone decides; trailing prose does not demote it');
  assert.equal(classifyString(''), C.OPAQUE);
  assert.equal(classifyString(null), C.OPAQUE);
  assert.equal(classifyString(42), C.OPAQUE);
});


test('CANARY: no user text survives sanitization', () => {
  const PROMPT = 'ช่วยสรุปว่า FORTUNE lesson4 พูดเรื่องอะไรให้สั้นที่สุด';
  const NOTEBOOK_REF = 'notebook://notebooks/abc-123/sources/def-456';

  const payload = [[PROMPT, 0, null, null, [[[null, 'n', 'n', NOTEBOOK_REF]]]], ['th'], [null, 3, 4]];
  const dumped = JSON.stringify(extractBoundedStructure(payload));

  // Every window, not just the whole string and two hand-picked tokens.
  //
  // The first version of this test asserted only that the full prompt and the
  // tokens "lesson4" and "FORTUNE" were absent — and it passed while
  // `prefix: val.slice(0, 8)` was in the implementation, because those tokens
  // sit past the eighth character. A leak detector that only looks where the
  // leak is not is the same defect this project keeps meeting, so it now
  // sweeps every window instead.
  const WINDOW = 6;
  for (let i = 0; i + WINDOW <= PROMPT.length; i++) {
    const window = PROMPT.slice(i, i + WINDOW);
    assert.ok(!dumped.includes(window),
      `no ${WINDOW}-character window of the prompt may appear in the output; found '${window}' at offset ${i}`);
  }
  assert.ok(!dumped.includes(PROMPT), 'nor the prompt whole');

  // The class is what survives, and it is the protocol's to give.
  const found = stringNodes(extractBoundedStructure(payload)).map((s) => s.cls);
  assert.ok(found.includes(C.OPAQUE), 'the prompt is recorded as opaque');
  assert.ok(found.includes(C.NOTEBOOK_REF), 'the notebook reference is recorded as such');
  for (const cls of found) {
    assert.ok(Object.values(C).includes(cls), `every recorded class is in the closed set, got '${cls}'`);
  }
});

test('sanitized strings keep their length and gain only a class', () => {
  const before = extractBoundedStructure(['hello']);
  assert.equal(before[0].type, 'string');
  assert.equal(before[0].length, 5);
  assert.equal(before[0].cls, C.OPAQUE);
  assert.deepEqual(Object.keys(before[0]).sort(), ['cls', 'length', 'type'],
    'the shape is additive — no other key may appear on a sanitized string');
});

test('non-string nodes are untouched by classification', () => {
  const out = extractBoundedStructure([1, true, null, undefined, 's']);
  assert.equal(out[0], 'number');
  assert.equal(out[1], true);
  assert.equal(out[2], null);
  assert.equal(out[3], undefined);
  assert.equal(out[4].type, 'string');
  assert.equal(stringNodes(out).length, 1, 'only the string node was annotated');
});


test('decodeAndSanitizePayload annotates every string node of a real-shaped body', () => {
  const inner = [['notebook://notebooks/x/sources/y', 0, null, null, [[[null, 'n', 'n', '']]]], 'th', [1, 2, 3]];
  const body = 'f.req=' + encodeURIComponent(JSON.stringify([null, JSON.stringify(inner)])) + '&at=csrf_token_value';

  const out = decodeAndSanitizePayload(body);
  assert.ok(out, 'a body carrying f.req= decodes');
  assert.equal(out.hasEnvelope, true);
  assert.equal(out.outerLength, 2);

  const strings = stringNodes(out.structure);
  assert.ok(strings.length > 0, 'the fixture actually contains strings');
  for (const s of strings) {
    assert.ok(Object.values(C).includes(s.cls), `each string node carries a class, got '${s.cls}'`);
  }
  assert.ok(strings.some((s) => s.cls === C.NOTEBOOK_REF), 'and the reference is found among them');

  // The CSRF token travels in the same body; it must not come back out.
  assert.ok(!JSON.stringify(out).includes('csrf_token_value'),
    'the token is read from the URL but never recorded in the structure');
});

test('the payload probe is off unless a boolean turns it on', () => {
  assert.equal(Injected.handleProbeSet({ enabled: true }), true);
  assert.equal(Injected.handleProbeSet({ enabled: false }), false);

  // A malformed toggle must leave the flag alone rather than half-enable it.
  assert.equal(Injected.handleProbeSet({ enabled: 'true' }), false, 'a string is not a boolean');
  assert.equal(Injected.handleProbeSet({}), false);
  assert.equal(Injected.handleProbeSet(null), false);

  // Leave it off for any test that runs after this one.
  Injected.handleProbeSet({ enabled: false });
});

test('the probe default is off — a debugging aid must not ship enabled', () => {
  // A fresh module instance, so the check cannot be satisfied by a previous
  // test having left the flag in some other state. Dropping the cache entry
  // re-runs the IIFE, which is what resets the flag to its declaration value.
  const path = require.resolve('../../extension-cloudflare/injected.js');
  delete require.cache[path];
  const fresh = require('../../extension-cloudflare/injected.js');
  assert.equal(fresh.handleProbeSet({}), false,
    'an invalid toggle returns false, which only holds if the flag is already false on load');
  assert.equal(fresh.classifyString('notebook://x'), fresh.STRING_CLASS.NOTEBOOK_REF,
    'the fresh instance classifies correctly');
});

test('depth and breadth caps still hold', () => {
  let deep = 'leaf';
  for (let i = 0; i < 9; i++) deep = [deep];
  assert.ok(JSON.stringify(extractBoundedStructure(deep)).includes('max_depth'),
    'depth beyond 6 is truncated, as before');

  assert.equal(extractBoundedStructure(Array.from({ length: 30 }, () => 's')).length, 20,
    'arrays are sliced to 20, as before');
});
