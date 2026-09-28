// Regression tests for log redaction in scripts/sw-console.mjs.
//
// The bridge auth token travels in a WebSocket URL query string, and the
// service worker logs that URL. Anything that prints it — a console log, a
// wrangler tail capture pasted into a ticket, a CI log — can therefore leak a
// live credential. wrangler tail redacts instanceId but NOT token=, so the
// redaction has to happen before the line reaches stdout.
//
// A token in a committed file or a public issue is a leaked token, which is
// why cloudflare-worker/wrangler.toml refuses to hold one and requires
// `wrangler secret put`. The same rule applies to whatever prints them.
//
// The function is extracted from the source rather than imported: sw-console.mjs
// connects to a debug port and calls process.exit() at module scope, so
// importing it would exit the test runner. Same approach as the other
// source-reading tests in this directory.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// A syntactically realistic value, in the shape the real token has.
//
// Deliberately NOT shaped like a real token. The real BRIDGE_SECRET starts
// with the literal prefix `gemini-bridge-` followed by a long hex run, which is
// exactly what the pre-commit Secret Guard matches on — a fixture that
// reproduced the real shape would block its own commit and teach the next
// person to reach for the allowlist instead of picking a different fixture.
// Never use a live credential here; that is a leaked credential.
const TOKEN = 'fixture-token-000111222333444555666777888999000111222333444555666';
const INSTANCE = '646001ce-43e9-4d81-aab3-c7d6bfe44be2';

const src = fs.readFileSync(
  new URL('../../scripts/sw-console.mjs', import.meta.url),
  'utf8'
);


const fnSrc = /export function redact\(line\) \{[\s\S]*?\n\}/.exec(src);
assert.ok(fnSrc, 'scripts/sw-console.mjs must export a redact() function');
const redact = eval(`(${fnSrc[0].replace('export function', 'function')})`);

test('a token in a query string is redacted', () => {
  // The exact shape wrangler tail emits. This is the case that motivated the
  // whole change: it redacts instanceId but leaves token= in plain text.
  const line =
    `GET https://prod.gemini-web-bridge.workers.dev/bridge?token=${TOKEN}` +
    `&client=background_sw&instanceId=${INSTANCE} - Ok`;

  const out = redact(line);
  assert.ok(!out.includes(TOKEN), 'the token must not survive redaction');
  assert.match(out, /token=REDACTED/);
});

test('a bare token= parameter is redacted, not only one after ? or &', () => {
  // The first version of this rule anchored on [?&] and leaked here. A log
  // line that has been split, or an object dumped without its URL, has no
  // leading ? — and that is precisely the case worth protecting.
  const out = redact(`connect: token=${TOKEN} trailing`);
  assert.ok(!out.includes(TOKEN), 'a bare token= parameter must be redacted');
});

test('a token inside a quoted JSON field is redacted', () => {
  const out = redact(`{"token":"${TOKEN}","client":"background_sw"}`);
  assert.ok(!out.includes(TOKEN));
  assert.match(out, /"token":"REDACTED"/);
});

test('a token in an Authorization header is redacted', () => {
  const out = redact(`Authorization: Bearer ${TOKEN}`);
  assert.ok(!out.includes(TOKEN));
});

test('the match is case-insensitive', () => {
  const out = redact(`TOKEN=${TOKEN}`);
  assert.ok(!out.includes(TOKEN), 'TOKEN= must be treated the same as token=');
});

test('other query parameters survive, so the line stays readable', () => {
  // Over-redaction is its own failure: a log where everything is REDACTED
  // cannot be diagnosed. Only credential-shaped parameters may be touched.
  const out = redact(`?token=${TOKEN}&client=background_sw&scope=app:abc`);
  assert.match(out, /client=background_sw/);
  assert.match(out, /scope=app:abc/);
});

test('instanceId is redacted — it identifies a browser install', () => {
  const out = redact(`wss://host/bridge?instanceId=${INSTANCE}`);
  assert.ok(!out.includes(INSTANCE));
});

test('a line with no secret is passed through unchanged', () => {
  const line = '[log/warn] [Bridge DO] stale socket cleanup complete';
  assert.equal(redact(line), line);
});

test('every print site in sw-console.mjs goes through redaction', () => {
  // The function only helps if it is actually used. A future print site added
  // with a bare console.log would silently reintroduce the leak, so the rule is
  // asserted structurally: the only console.log in the file is the one inside
  // say(), which scrubs.
  const bare = src
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => {
      const code = line.replace(/\/\/.*$/, '');
      if (!/console\.log\(/.test(code)) return false;
      // The definition of say() itself is the one legitimate use.
      return !/const say = /.test(code);
    });

  assert.deepEqual(
    bare,
    [],
    'console.log must go through say(), which redacts. Offending line(s): ' +
      bare.map((b) => b.n).join(', ')
  );
});
