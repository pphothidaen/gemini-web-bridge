// Contract tests for the bridge handshake secret rename (KAN-219).
//
// Before this rename, one credential had three names spread across three
// systems: the worker read `this.env.BRIDGE_SECRET`, the Doppler/GitHub
// secret was called BRIDGE_AUTH_TOKEN, and CD remapped one to the other
// (cd.yml: `BRIDGE_SECRET: ${{ env.bridge_token }}`). The live worker
// carried BOTH as secrets, but only BRIDGE_SECRET was ever read, so
// BRIDGE_AUTH_TOKEN was an unused binding that looked like a second live
// credential.
//
// These tests pin the single name across all three layers, and pin that the
// old name is gone from the layers that are read at runtime. They are
// deliberately literal: the point is to catch a partial rename, so each
// assertion names one file and one exact shape.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

test('worker reads the handshake secret from BRIDGE_AUTH_TOKEN, not BRIDGE_SECRET', () => {
  const src = read('cloudflare-worker/src/index.js');

  assert.ok(
    src.includes('this.env.BRIDGE_AUTH_TOKEN'),
    'index.js must read this.env.BRIDGE_AUTH_TOKEN',
  );
  assert.ok(
    !src.includes('this.env.BRIDGE_SECRET'),
    'index.js must no longer read this.env.BRIDGE_SECRET — the old binding is dead weight ' +
      'on the live worker and suggests two live credentials where there is one',
  );
});

test('extension ships the __BRIDGE_AUTH_TOKEN__ placeholder, not the old one', () => {
  const bg = read('extension-cloudflare/background.js');

  assert.match(
    bg,
    /DEFAULT_BRIDGE_AUTH_TOKEN\s*=\s*"__BRIDGE_AUTH_TOKEN__"/,
    'the extension default must be the __BRIDGE_AUTH_TOKEN__ build-time placeholder',
  );
  assert.ok(
    !bg.includes('__BRIDGE_SECRET__'),
    'the extension must not still reference __BRIDGE_SECRET__',
  );
});

test('build script substitutes __BRIDGE_AUTH_TOKEN__ from Doppler BRIDGE_AUTH_TOKEN', () => {
  const build = read('scripts/build-extension.py');

  assert.ok(
    build.includes('__BRIDGE_AUTH_TOKEN__'),
    'the build script must substitute __BRIDGE_AUTH_TOKEN__',
  );
  assert.ok(
    !build.includes('__BRIDGE_SECRET__'),
    'the build script must not still substitute __BRIDGE_SECRET__',
  );
});

test('the worker type declaration matches the new binding name', () => {
  const dts = read('cloudflare-worker/worker-configuration.d.ts');

  assert.match(dts, /BRIDGE_AUTH_TOKEN:/, 'the Env type must declare BRIDGE_AUTH_TOKEN');
});

test('CD publishes the Doppler BRIDGE_AUTH_TOKEN to the BRIDGE_AUTH_TOKEN binding', () => {
  const cd = read('.github/workflows/cd.yml');

  assert.ok(
    cd.includes('wrangler secret put BRIDGE_AUTH_TOKEN'),
    'cd.yml must put the secret under the new binding name',
  );
  assert.ok(
    !cd.includes('wrangler secret put BRIDGE_SECRET'),
    'cd.yml must not still put the secret under the old binding name',
  );
});
