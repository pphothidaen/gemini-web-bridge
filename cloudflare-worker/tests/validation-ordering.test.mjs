// Regression tests for request validation ordering in /v1/chat/completions.
//
// The empty-`messages` check used to sit AFTER the extension-readiness gate.
// With no browser attached the worker therefore spent the full 12s
// waitForExtension() grace window and then answered 503 "Chrome Extension is
// not connected" — for a request that was malformed no matter what. Two
// consequences beyond the misleading status:
//
//   1. The caller was pointed at their browser instead of their payload, and
//      held a slot in the wait queue for a request that could never succeed.
//   2. The 400 branch was unreachable whenever no extension was attached, so
//      the integration test asserting it had to be gated behind a live
//      browser. Validation whose answer depends on unrelated infrastructure
//      state cannot be regression-tested in CI.
//
// These pin the contract that makes it testable: shape errors are answered
// identically whether or not an extension is connected, and answered promptly.
//
// The gateway in production is roughly 12s, which is what made the
// misordering so easy to miss locally — a fast machine hides it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as catalog from '../src/model-catalog.js';
import * as emulator from '../src/tool-emulator.ts';
import { makeCtx } from './helpers/fake-ctx.mjs';

const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const context = {
  ...catalog,
  ...emulator,
  DurableObject: class {},
  crypto,
  Request,
  Response,
  URL,
  TextEncoder,
  TextDecoder,
  TransformStream,
  ReadableStream,
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => {}
};

const { GeminiBridgeDO } = vm.runInNewContext(
  source.replace(/import[\s\S]*?from "[^"\n]+";/g, '')
    .replaceAll('export class ', 'class ')
    .replace('export default {', 'const entry = {') +
  '\n;({GeminiBridgeDO})',
  context
);

// A DO with no extension attached: isExtensionReady() is false, which is
// exactly the state in which the old ordering produced a 503 after 12s.
const disconnectedBridge = () =>
  new GeminiBridgeDO(makeCtx(), { CLIENT_API_KEY: 'client-secret', BRIDGE_SECRET: 'bridge-secret' });

const post = (b, body) =>
  b.fetch(new Request('https://test/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer client-secret', 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  }));

test('empty messages is a 400 with no extension attached, without waiting', async () => {
  const b = disconnectedBridge();
  assert.equal(b.isExtensionReady(), false, 'precondition: no extension');

  const started = Date.now();
  const res = await post(b, { messages: [] });
  const elapsed = Date.now() - started;

  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error.message, /non-empty array/);
  assert.equal(data.error.type, 'invalid_request_error');
  // The old path burned the whole reconnect grace window first. Anything near
  // that means validation has moved back behind the readiness gate.
  assert.ok(elapsed < 2000, `should not wait for an extension, waited ${elapsed}ms`);
});

test('the 400 is the same whether or not an extension is connected', async () => {
  const withExt = disconnectedBridge();
  withExt.currentTokens = { sessionReady: true };
  withExt.replaceModelCatalog({
    protocolVersion: 2,
    models: [{ id: 'm1', verification: 'verified', mapping_revision: 'r1' }]
  });
  withExt.activeSocket = { readyState: 1, send() {} };
  assert.equal(withExt.isExtensionReady(), true, 'precondition: extension ready');

  const without = await post(disconnectedBridge(), { messages: [] });
  const with_ = await post(withExt, { messages: [] });

  assert.equal(without.status, 400);
  assert.equal(with_.status, 400, 'validation must not depend on connection state');
  assert.equal((await without.json()).error.message, (await with_.json()).error.message);
});

test('absent and non-array messages are rejected the same way', async () => {
  for (const body of [{}, { messages: null }, { messages: 'hello' }, { messages: {} }]) {
    const res = await post(disconnectedBridge(), body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${res.status}`);
  }
});

test('malformed JSON is still a 400 and never reaches the readiness gate', async () => {
  const res = await post(disconnectedBridge(), 'not valid json{{{');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'bad_json');
});

test('a well-formed request still reports a missing extension as 503', async () => {
  // Guard the other direction: moving validation earlier must not turn a
  // genuine "no browser attached" case into a 400. This is the same 503
  // contract red-team-adversarial.test.mjs pins.
  const res = await post(disconnectedBridge(), {
    model: 'gemini-web-thinking',
    messages: [{ role: 'user', content: 'hello' }]
  });

  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'extension_disconnected');
});
