/**
 * KAN-166: the backoff exists in three places and they must not drift.
 *
 * content.js carries an inline fallback for Settings, used whenever
 * settings.js has not populated globalThis.GeminiBridgeSettings. That copy had
 * already drifted: KAN-165 fixed the jitter in background.js and settings.js,
 * and the content-script copy silently kept the old `min(exp + rnd()*1000, max)`
 * shape — where the jitter is clipped away at the cap, the exact defect
 * KAN-165 set out to remove. Nothing failed, because the copy is only reached
 * when settings.js is absent.
 *
 * These tests pin all three to the same behaviour so the next drift fails CI
 * instead of production.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Settings = require('../../extension-cloudflare/settings.js');
import { computeBackoff as backgroundBackoff } from '../../extension-cloudflare/background.js';

const contentSource = fs.readFileSync(
  new URL('../../extension-cloudflare/content.js', import.meta.url),
  'utf8'
);

/** Pull the inline fallback's computeBackoff out of content.js and call it. */
function contentFallbackBackoff(attempt, rnd) {
  const m = /computeBackoff:\s*\(attempt[^)]*\)\s*=>\s*\{([\s\S]*?)\n\s{8}\}/.exec(contentSource);
  assert.ok(m, 'content.js must still declare a computeBackoff fallback');
  const fn = vm.runInNewContext(
    `(function(){ return (attempt, base, max, rnd) => {${m[1]}\n}; })()`
  );
  return fn(attempt, 1000, 30000, rnd);
}

const implementations = [
  ['settings.js', (a, r) => Settings.computeBackoff(a, 1000, 30000, r)],
  ['background.js', (a, r) => backgroundBackoff(a, 1000, 30000, r)],
  ['content.js fallback', contentFallbackBackoff],
];

test('all three computeBackoff copies agree on every attempt', () => {
  // Deterministic rnd values so drift surfaces as a value mismatch, not flakiness.
  for (const rndValue of [0, 0.25, 0.5, 0.999]) {
    for (let attempt = 0; attempt <= 10; attempt++) {
      const values = implementations.map(([, fn]) => fn(attempt, () => rndValue));
      for (let i = 1; i < implementations.length; i++) {
        assert.equal(
          values[i],
          values[0],
          `computeBackoff(attempt=${attempt}, rnd=${rndValue}) diverged: ` +
            `${implementations[0][0]}=${values[0]} vs ${implementations[i][0]}=${values[i]}`
        );
      }
    }
  }
});

test('no copy still clips the jitter away at the cap', () => {
  // The KAN-165 defect in its simplest form: at the cap, a low random value
  // must still yield a delay well below the maximum.
  for (const [name, fn] of implementations) {
    const capped = fn(9, () => 0.1);
    assert.ok(
      capped < 30000,
      `${name} still pins capped attempts to the maximum (got ${capped}ms) — ` +
        'the jitter is being clipped, which is the KAN-165 bug'
    );
  }
});
