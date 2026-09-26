// Prevents the September-2026 incident from repeating: both production tokens
// were committed verbatim to extension-cloudflare/ ("pre-filled defaults",
// commits 078824b → 4f6cced) and stayed retrievable from the public repo's git
// history long after the working tree was cleaned.
//
// Rule enforced here: the extension NEVER ships a literal secret. Values must be
// the build-time placeholders `__BRIDGE_AUTH_TOKEN__` / `__CLIENT_API_TOKEN__`
// that scripts/build-extension.py substitutes from Doppler/env.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const EXT_DIR = new URL('../../extension-cloudflare/', import.meta.url);
const files = fs.readdirSync(EXT_DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && /\.(js|html|json)$/.test(e.name))
  .map((e) => e.name);

const read = (name) => fs.readFileSync(path.join(EXT_DIR.pathname, name), 'utf8');
const sources = files.map((name) => ({ name, text: read(name) }));

test('extension: no hardcoded token literals (hermes-* / gemini-bridge-*)', () => {
  const offenders = sources
    .filter(({ text }) => /hermes-[a-f0-9]{16,}/i.test(text) || /gemini-bridge-[a-f0-9]{16,}/i.test(text))
    .map(({ name }) => name);
  assert.deepEqual(offenders, [], `literal secrets found in: ${offenders.join(', ')}`);
});

test('extension: default secret/token constants must be build-time placeholders', () => {
  const offenders = [];
  for (const { name, text } of sources) {
    for (const match of text.matchAll(/(DEFAULT_BRIDGE_SECRET|DEFAULT_CLIENT_API_TOKEN)\s*[:=]\s*["']([^"']*)["']/g)) {
      const [, constant, value] = match;
      if (value !== `__${constant === 'DEFAULT_BRIDGE_SECRET' ? 'BRIDGE_AUTH_TOKEN' : 'CLIENT_API_TOKEN'}__`) {
        offenders.push(`${name}: ${constant} = "${value}"`);
      }
    }
  }
  assert.deepEqual(offenders, [], `non-placeholder defaults:\n${offenders.join('\n')}`);
});

test('extension: the placeholder substitution contract still exists in the build script', () => {
  const build = fs.readFileSync(new URL('../../scripts/build-extension.py', import.meta.url), 'utf8');
  assert.ok(build.includes('__BRIDGE_AUTH_TOKEN__'), 'build script must substitute __BRIDGE_AUTH_TOKEN__');
  assert.ok(build.includes('__CLIENT_API_TOKEN__'), 'build script must substitute __CLIENT_API_TOKEN__');
});

test('worker config files: no secrets in wrangler toml files', () => {
  for (const name of ['../wrangler.toml', '../wrangler.staging.toml']) {
    const text = fs.readFileSync(new URL(name, import.meta.url), 'utf8');
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^(BRIDGE_AUTH_TOKEN|CLIENT_API_TOKEN|GEMINI_API_KEY|CLOUDFLARE_API_TOKEN)\s*=/.test(l));
    assert.deepEqual(lines, [], `${name} must not assign secrets as plain vars:\n${lines.join('\n')}`);
  }
});
