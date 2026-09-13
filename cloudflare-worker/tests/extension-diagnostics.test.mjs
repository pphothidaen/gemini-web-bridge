import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Settings = require('../../extension-cloudflare/settings.js');
const contentSource = fs.readFileSync(new URL('../../extension-cloudflare/content.js', import.meta.url), 'utf8');

test('shared settings resolver handles defaults, empty tokens, and enforcement modes', () => {
  // Empty / undefined settings
  const emptyRes = Settings.resolveSettings({});
  assert.equal(emptyRes.workerUrl, Settings.DEFAULT_WORKER_URL);
  assert.equal(emptyRes.bridgeToken, Settings.DEFAULT_BRIDGE_SECRET);
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

test('exponential backoff with jitter doubles and caps at 30 seconds', () => {
  // Deterministic randomFn that returns 0.5 (500ms jitter)
  const mockRandom = () => 0.5;

  const delay0 = Settings.computeBackoff(0, 1000, 30000, mockRandom);
  assert.equal(delay0, 1500); // 1000 + 500

  const delay1 = Settings.computeBackoff(1, 1000, 30000, mockRandom);
  assert.equal(delay1, 2500); // 2000 + 500

  const delay2 = Settings.computeBackoff(2, 1000, 30000, mockRandom);
  assert.equal(delay2, 4500); // 4000 + 500

  // High attempt must cap at 30,000ms max
  const delay10 = Settings.computeBackoff(10, 1000, 30000, mockRandom);
  assert.equal(delay10, 30000);
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
      runtime: { getURL: p => p },
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
  await Promise.resolve();

  assert.equal(sockets.length, 1);
  const initialTimerCount = timers.length;

  // Server rejects with 401 Unauthorized
  sockets[0].close(4401, 'Unauthorized: Invalid Bridge Secret');

  // Verify that NO reconnect timer was scheduled!
  assert.equal(timers.length, initialTimerCount, 'Reconnect timer must NOT be scheduled on auth failure');

  // Updating the settings in storage clears auth failure and triggers reconnect
  storageListener({ bridgeToken: { newValue: 'new-valid-token' } }, 'sync');
  await Promise.resolve();

  // A new socket should now be connected
  assert.equal(sockets.length, 2);
  assert.ok(sockets[1].url.includes('new-valid-token'));
});
