import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Settings = require('../../extension-cloudflare/settings.js');
import { CONFLICT_RETRY_DELAY_MS, CONFLICT_RETRY_JITTER_MS } from '../../extension-cloudflare/background.js';

const contentSource = fs.readFileSync(new URL('../../extension-cloudflare/content.js', import.meta.url), 'utf8');
const workerSource = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

/** The live value the DO evicts on, not a copy. */
function workerStaleTimeout() {
  const m = /this\.STALE_CONNECTION_TIMEOUT_MS\s*=\s*(\d+)/.exec(workerSource);
  assert.ok(m, 'this.STALE_CONNECTION_TIMEOUT_MS must still exist in src/index.js');
  return Number(m[1]);
}

test('shared settings resolver handles defaults, empty tokens, and enforcement modes', () => {
  // Empty / undefined settings
  const emptyRes = Settings.resolveSettings({});
  assert.equal(emptyRes.workerUrl, Settings.DEFAULT_WORKER_URL);
  assert.equal(emptyRes.bridgeToken, Settings.DEFAULT_BRIDGE_AUTH_TOKEN);
  assert.equal(emptyRes.rawBridgeToken, '');
  assert.equal(emptyRes.isDefaultToken, true);
  assert.equal(emptyRes.enforcementMode, 'strict');

  // Custom token and permissive mode
  const customRes = Settings.resolveSettings({
    workerUrl: ' https://my-custom-worker.dev ',
    bridgeToken: ' my-secret-token ',
    enforcementMode: 'permissive'
  });
  assert.equal(customRes.workerUrl, 'https://my-custom-worker.dev');
  assert.equal(customRes.bridgeToken, 'my-secret-token');
  assert.equal(customRes.rawBridgeToken, 'my-secret-token');
  assert.equal(customRes.isDefaultToken, false);
  assert.equal(customRes.enforcementMode, 'permissive');
});

test('backoff uses full jitter, so the spread survives the cap', () => {
  // KAN-165. The old shape was min(exponential + floor(rnd()*1000), max): the
  // jitter was added on top and then clipped, so every attempt at or past the
  // cap returned exactly maxDelay and the randomness vanished. These two cases
  // are the whole point — they are what the old implementation got wrong.

  // At the cap, a low random value must still produce a delay well under max.
  const lowRandom = () => 0.1;
  const capped = Settings.computeBackoff(9, 1000, 30000, lowRandom);
  assert.equal(capped, 3000, 'a capped attempt must still be randomised, not pinned to max');

  // And the spread must widen with the delay rather than stay a flat 999ms.
  const at1 = Settings.computeBackoff(1, 1000, 30000, () => 0.999);
  const at4 = Settings.computeBackoff(4, 1000, 30000, () => 0.999);
  assert.equal(at1, 1998);
  assert.equal(at4, 15984);
  assert.ok(at4 > at1 * 5, 'spread must grow with the delay, not stay fixed');
});

test('backoff never exceeds the cap and never returns a negative delay', () => {
  for (const rnd of [() => 0, () => 0.5, () => 0.999999]) {
    for (let attempt = 0; attempt <= 12; attempt++) {
      const d = Settings.computeBackoff(attempt, 1000, 30000, rnd);
      assert.ok(d >= 0, `attempt ${attempt} produced a negative delay`);
      assert.ok(d <= 30000, `attempt ${attempt} exceeded the cap: ${d}`);
    }
  }
});

test('the 409 conflict retry is jittered rather than a flat timer', () => {
  // CONFLICT_RETRY_DELAY_MS is a fixed 4 minutes, so an unjittered retry made
  // every client that lost the same slot come back in lockstep. The jitter is
  // additive, so it must never pull the retry earlier than the delay itself.
  assert.ok(CONFLICT_RETRY_JITTER_MS > 0, 'the 409 retry must carry some jitter');
  assert.ok(
    CONFLICT_RETRY_DELAY_MS >= workerStaleTimeout(),
    'jitter is additive, so the base delay must still outlast the DO stale threshold'
  );
});

test('invalid token halts reconnection until settings change or manual retry', async () => {
  const timers = [];
  const sockets = [];
  let storageListener = null;

  class WebSocketMock {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    close(code, reason) {
      this.readyState = 3;
      this.onclose?.({ code, reason });
    }
  }

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    URL,
    Map,
    Array,
    Boolean,
    Set,
    JSON,
    Math,
    Date,
    document: {
      addEventListener: () => {},
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }),
      body: { appendChild() {} },
      head: { appendChild() {} }
    },
    window: { addEventListener() {} },
    WebSocket: WebSocketMock,
    setTimeout: (fn, delay) => {
      timers.push({ fn, delay, cancelled: false });
      return timers.length - 1;
    },
    clearTimeout: (id) => { if (timers[id]) timers[id].cancelled = true; },
    chrome: {
      // No chrome.runtime here: this harness models a non-extension
      // environment, where the direct tab WebSocket is the transport.
      // Orphaned extension contexts are covered in
      // extension-orphaned-context.test.mjs.
      storage: {
        sync: {
          get: async () => ({ workerUrl: 'https://worker.test', bridgeToken: 'invalid-token' })
        },
        local: { get: (k, cb) => cb({}), set: (o, cb) => cb?.(), remove: (k, cb) => cb?.() },
        onChanged: { addListener: (fn) => { storageListener = fn; } }
      }
    }
  };

  vm.runInNewContext(contentSource, sandbox);
  // Drain the microtask queue, not just one tick. The content script's
  // init awaits chrome.storage, then opens the direct WebSocket; that
  // chain needs several ticks to settle.
  // Awaiting a single Promise.resolve() left sockets.at(-1) undefined and
  // failed with "Cannot set properties of undefined".
  for (let i = 0; i < 10; i++) await Promise.resolve();

  assert.equal(sockets.length, 1);
  const initialTimerCount = timers.length;

  // Server rejects with 401 Unauthorized
  sockets[0].close(4401, 'Unauthorized: Invalid Bridge Secret');

  // Verify that NO reconnect timer was scheduled!
  assert.equal(timers.length, initialTimerCount, 'Reconnect timer must NOT be scheduled on auth failure');

  // Updating the settings in storage clears auth failure and triggers reconnect
  storageListener({ bridgeToken: { newValue: 'new-valid-token' } }, 'sync');
  // Drain the microtask queue, not just one tick. The content script's
  // init awaits chrome.storage, then opens the direct WebSocket; that
  // chain needs several ticks to settle.
  // Awaiting a single Promise.resolve() left sockets.at(-1) undefined and
  // failed with "Cannot set properties of undefined".
  for (let i = 0; i < 10; i++) await Promise.resolve();

  // A new socket should now be connected
  assert.equal(sockets.length, 2);
  assert.ok(sockets[1].url.includes('new-valid-token'));
});
