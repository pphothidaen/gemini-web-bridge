// Guards against the version drift that shipped 4.3.4 in /health while
// package.json said 4.3.7 and the extension manifest said 4.4.3.
//
// Policy: the worker version, the npm package, the lockfile and the Chrome
// extension ship as ONE version line (the unified CHANGELOG). Bumping a
// release therefore means bumping all four — this test makes that a hard
// failure instead of a production surprise.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const readJson = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const readText = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

const pkg = readJson('../package.json');
const lock = readJson('../package-lock.json');
const source = readText('../src/index.js');
const manifest = readJson('../../extension-cloudflare/manifest.json');

test('version: WORKER_VERSION constant in src/index.js matches package.json', () => {
  const match = source.match(/const WORKER_VERSION = "([^"]+)"/);
  assert.ok(match, 'src/index.js must declare a WORKER_VERSION constant');
  assert.equal(match[1], pkg.version);
});

test('version: package-lock.json matches package.json', () => {
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});

test('version: extension manifest matches the worker version (unified release line)', () => {
  assert.equal(manifest.version, pkg.version);
});

test('version: no user-visible hardcoded version strings remain in the worker', () => {
  // /health, MCP serverInfo and ping must all read WORKER_VERSION.
  const hardcoded = [...source.matchAll(/version: "(\d+\.\d+\.\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(hardcoded, [], `hardcoded version literals found: ${hardcoded.join(', ')}`);
  assert.ok(!/Cloud Hub v\d+\.\d+\.\d+/.test(source), 'ping text must interpolate WORKER_VERSION');
});
