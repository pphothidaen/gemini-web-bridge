/**
 * KAN-236: WINANSI_EXTRA_CHARS had no test, and that gap already cost nine
 * characters.
 *
 * A repair of the verbose-logging bug rewrote the table and dropped
 * € … † ‡ ‚ ƒ „ ˆ ‰ on the way through. The build passed, the suite passed, and
 * nothing said so — this was the one hand-maintained table in the file with no
 * coverage at all. Every PDF containing a euro sign or an ellipsis, which is
 * ordinary in BaZi output, would have rendered them as `?`.
 *
 * The point is not the table itself. It is that a silent drop in a constant
 * should not be mergeable again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SOURCE = fs.readFileSync(
  new URL('../src/index.js', import.meta.url).pathname,
  'utf8'
);

function extract(startMarker, endMarker) {
  const start = SOURCE.indexOf(startMarker);
  assert.ok(start > 0, `expected to find ${startMarker} in src/index.js`);
  const end = SOURCE.indexOf(endMarker, start);
  assert.ok(end > start, `expected to find ${endMarker} after ${startMarker}`);
  return SOURCE.slice(start, end);
}

const setSrc = extract('const WINANSI_EXTRA_CHARS = new Set([', ']);');
const fnSrc = extract('function sanitizeForWinAnsi(text)', '\n}\n');
// Both slices stop BEFORE their terminator, so both are rebuilt here: setSrc
// loses the closing `])` and fnSrc loses the closing `}`.
const sanitize = new Function(`${setSrc}\n])\nreturn (${fnSrc}\n})`)();

// Parsed from the source rather than copied here, so the test and the table
// cannot drift apart in the way a duplicated list always eventually does.
const declared = [...setSrc.matchAll(/0x([0-9A-Fa-f]{4})/g)].map((m) => parseInt(m[1], 16));

test('every character in the table survives sanitisation', () => {
  assert.ok(declared.length >= 27, `expected the full table, found ${declared.length}`);
  for (const code of declared) {
    assert.equal(
      sanitize(String.fromCharCode(code)),
      String.fromCharCode(code),
      `U+${code.toString(16).padStart(4, '0')} (${String.fromCharCode(code)}) must survive: ` +
      'it is CP1252-encodable and occurs in real readings'
    );
  }
});

test('the nine characters lost in the repair are present again', () => {
  // Named individually. A count catches "nine went missing"; this catches "nine
  // different ones went missing", which is what actually happened.
  const lost = [0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030];
  for (const code of lost) {
    assert.ok(declared.includes(code),
      `U+${code.toString(16)} (${String.fromCharCode(code)}) is missing from ` +
      'WINANSI_EXTRA_CHARS');
  }
});

test('characters CP1252 cannot encode are replaced, not passed through', () => {
  // Thai and Han — the reason this function exists at all.
  assert.equal(sanitize('ก'), '?');
  assert.equal(sanitize('甲'), '?');
  assert.equal(sanitize('abcXYZ 123'), 'abcXYZ 123');
  assert.equal(sanitize('é'), 'é');
});

test('newlines and tabs survive so PDF line breaks are not destroyed', () => {
  assert.equal(sanitize('a\nb\tc'), 'a\nb\tc');
});

test('verbose logging reads env, not a bare global', () => {
  // The bug this file's sibling fixed: VERBOSE was computed from a bare
  // `typeof BRIDGE_VERBOSE` global, which does not exist in Workers. Every
  // vlog in the worker was therefore dead in production regardless of config.
  assert.doesNotMatch(SOURCE, /typeof BRIDGE_VERBOSE !== "undefined"/,
    'a bare-global read can never see a Worker binding');
  assert.match(SOURCE, /VERBOSE_FLAG = \(this\.env\.BRIDGE_VERBOSE === "1"\)/,
    'the flag must be set from the Durable Object env');
  assert.match(SOURCE, /function vlog\(\.\.\.args\) \{\s*if \(VERBOSE_FLAG\)/);
});
