import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { scopeFromPath, scopeToUrl } from '../../extension-cloudflare/protocol-messages.js';
import * as catalog from '../src/model-catalog.js';

// Instantiate GeminiBridgeDO from cloudflare-worker/src/index.js
// We strip cloudflare:workers imports and run in a VM context with stubs
const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const context = {
  ...catalog,
  DurableObject: class {},
  crypto,
  Request,
  Response,
  URL,
  TextEncoder,
  TextDecoder,
  TextEncoderStream,
  TransformStream,
  ReadableStream,
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => {},
};

const { GeminiBridgeDO } = vm.runInNewContext(
  source.replace(/import[\s\S]*?from "[^"\n]+";/g, '')
    .replaceAll('export class ', 'class ')
    .replace('export default {', 'const entry = {') +
  '\n;({GeminiBridgeDO})',
  context
);

const NOTEBOOK_ID = 'b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0';

function createBridge() {
  const b = new GeminiBridgeDO({}, { CLIENT_API_TOKEN: 'secret-token-123', BRIDGE_AUTH_TOKEN: 'bridge-secret' });
  b.currentTokens = { sessionReady: true };
  b.lastNotebookScope = `notebook:${NOTEBOOK_ID}`;
  return b;
}

test('1. scopeFromPath: parses /app, /app/<convId>, and /notebook/<id> paths correctly', () => {
  assert.equal(scopeFromPath('/app'), 'app');
  assert.equal(scopeFromPath('/app/c_12345'), 'app:c_12345');
  assert.equal(scopeFromPath(`/notebook/${NOTEBOOK_ID}`), `notebook:${NOTEBOOK_ID}`);
  assert.equal(scopeFromPath('/unknown/path'), 'app');
  assert.equal(scopeFromPath(''), 'app');
  assert.equal(scopeFromPath(null), 'app');
});

test('2. scopeToUrl: maps canonical scopes to valid gemini.google.com URLs', () => {
  assert.equal(scopeToUrl('app'), 'https://gemini.google.com/app');
  assert.equal(scopeToUrl('app:c_12345'), 'https://gemini.google.com/app/c_12345');
  assert.equal(scopeToUrl(`notebook:${NOTEBOOK_ID}`), `https://gemini.google.com/notebook/${NOTEBOOK_ID}`);
  assert.equal(scopeToUrl(''), 'https://gemini.google.com/app');
  assert.equal(scopeToUrl(null), 'https://gemini.google.com/app');
});

test('3. resolveScopeInput: resolves aliases, bare scopes, and full URLs', () => {
  const b = createBridge();
  assert.equal(b.resolveScopeInput('app'), 'app');
  assert.equal(b.resolveScopeInput('default'), 'app');
  assert.equal(b.resolveScopeInput('normal'), 'app');
  assert.equal(b.resolveScopeInput('notebook'), `notebook:${NOTEBOOK_ID}`);
  assert.equal(b.resolveScopeInput('app:c_999'), 'app:c_999');
  assert.equal(b.resolveScopeInput(`notebook:${NOTEBOOK_ID}`), `notebook:${NOTEBOOK_ID}`);
  assert.equal(b.resolveScopeInput(`https://gemini.google.com/notebook/${NOTEBOOK_ID}`), `notebook:${NOTEBOOK_ID}`);
  assert.equal(b.resolveScopeInput('https://gemini.google.com/app/conv_777'), 'app:conv_777');
});

test('4. scopeToUrl path traversal rejection: rejects directory traversal and unsafe characters', () => {
  assert.equal(scopeToUrl('app:../../etc/passwd'), 'https://gemini.google.com/app');
  assert.equal(scopeToUrl('notebook:../admin'), 'https://gemini.google.com/app');
  assert.equal(scopeToUrl('app:evil/path'), 'https://gemini.google.com/app');
  assert.equal(scopeToUrl('invalid:12345'), 'https://gemini.google.com/app');
  assert.equal(scopeToUrl('app:semi;colon'), 'https://gemini.google.com/app');
});

test('5. resolveScopeInput path traversal rejection: rejects traversal strings and malformed scopes', () => {
  const b = createBridge();
  assert.equal(b.resolveScopeInput('../../etc/passwd'), null);
  assert.equal(b.resolveScopeInput('/notebook/../traversal'), null);
  assert.equal(b.resolveScopeInput('app:../bad'), null);
  assert.equal(b.resolveScopeInput('notebook:bad/path'), null);
  assert.equal(b.resolveScopeInput('malicious_custom_scope'), null);
});

test('6. scopeToUrl and resolveScopeInput with special characters and encoding safety', () => {
  const b = createBridge();
  assert.equal(b.resolveScopeInput('app:valid_id-123'), 'app:valid_id-123');
  assert.equal(scopeToUrl('app:valid_id-123'), 'https://gemini.google.com/app/valid_id-123');
  assert.equal(b.resolveScopeInput('app:has space'), null);
  assert.equal(b.resolveScopeInput('notebook:foo?bar=1'), null);
  assert.equal(scopeToUrl('notebook:foo?bar=1'), 'https://gemini.google.com/app');
});

test('7. scope switching RED phase: path traversal in /app URL pathname is normalized to safe scope', () => {
  const b = createBridge();
  // /app/../../etc/passwd starts with /app/ prefix so resolveScopeInput
  // returns "app" (safe fallback). The key security property: the resulting
  // scope never contains traversal characters — scopeToUrl("app") yields a
  // safe URL with no injection vector.
  const scope = b.resolveScopeInput('/app/../../etc/passwd');
  assert.equal(scope, 'app');
  assert.equal(scopeToUrl(scope), 'https://gemini.google.com/app');
  // Non-app/non-notebook paths DO get rejected
  assert.equal(b.resolveScopeInput('/etc/../../traversal'), null);
});
