// Regression test for the back/forward-cache (BFCache) port eviction that
// produced:
//   "Unchecked runtime.lastError: The page keeping the extension port is moved
//    into back/forward cache, so the message channel is closed."
//
// Two independent defects combined to make the bridge go permanently dead on
// every BFCache restore (which is what made prod flap between
// CONNECTED_AND_READY and DISCONNECTED during endpoint testing):
//
//  1. Chrome sets chrome.runtime.lastError when *it* kills a port. The only way
//     to acknowledge it is to read it synchronously inside the onDisconnect
//     callback; not reading it is what prints "Unchecked runtime.lastError".
//
//  2. When the page is frozen in BFCache, timers do not run. Both port
//     onDisconnect handlers recover via setTimeout(..., 1000), so that retry is
//     queued but never executes. `pageshow` then only reset `isRefreshing` and
//     rebuilt nothing, leaving a live content script holding no port at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../extension-cloudflare/content.js', import.meta.url), 'utf8');

/**
 * Sandbox that models the real Chrome behaviour we care about:
 *  - runtime.connect() hands back a port we can kill the way Chrome does
 *  - runtime.lastError is only populated *while* the disconnect callback runs,
 *    and every read is counted so we can assert the extension acknowledged it
 *  - window events are captured so we can drive pagehide/pageshow by hand
 */
function setupVm() {
  const ports = [];
  const windowListeners = {};
  const timers = [];
  let lastErrorMessage = null;
  let lastErrorReads = 0;

  const node = () => {
    const listeners = {};
    const el = {
      innerText: '', textContent: '', style: {}, classList: { contains: () => false },
      getAttribute: () => null, querySelector: () => null, remove() {},
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      _html: '',
    };
    Object.defineProperty(el, 'innerHTML', {
      get() { return el._html; }, set(v) { el._html = v; },
    });
    return el;
  };

  const document = {
    querySelectorAll: () => [],
    querySelector: () => node(),
    createElement: () => node(),
    body: { appendChild() {} },
    head: { appendChild() {} },
    addEventListener() {},
  };

  const chrome = {
    storage: {
      sync: { get: async () => ({ workerUrl: 'https://worker.test', bridgeToken: 'test-secret' }) },
      local: { get: (_k, cb) => cb?.({}), set: (_o, cb) => cb?.(), remove: (_k, cb) => cb?.() },
      onChanged: { addListener() {} },
    },
    runtime: {
      id: 'live-extension-id',
      get lastError() {
        // Mirrors Chrome: the getter is only meaningful during the callback.
        if (lastErrorMessage) { lastErrorReads++; return { message: lastErrorMessage }; }
        return undefined;
      },
      getURL: p => p,
      connect: (info) => {
        const port = {
          name: info?.name,
          disconnected: false,
          _disconnectListeners: [],
          onMessage: { addListener(fn) { port._onMessage = fn; } },
          onDisconnect: { addListener(fn) { port._disconnectListeners.push(fn); } },
          postMessage() {},
          /** Kill the port the way Chrome does on BFCache eviction. */
          kill(reason) {
            port.disconnected = true;
            lastErrorMessage = reason;
            lastErrorReads = 0;
            try {
              port._disconnectListeners.forEach(fn => fn());
            } finally {
              // Chrome clears lastError as soon as the callback returns.
              lastErrorMessage = null;
            }
            return lastErrorReads;
          },
        };
        ports.push(port);
        return port;
      },
    },
  };

  const sessionStore = new Map();
  vm.runInNewContext(source, {
    console: { log() {}, warn() {}, error() {}, debug() {} },
    URL, Map, Array, Boolean, Object, JSON, Promise, Number, String, Error, RegExp, Set,
    document,
    window: {
      addEventListener(type, fn) { (windowListeners[type] = windowListeners[type] || []).push(fn); },
      postMessage() {},
    },
    location: { pathname: '/app', href: 'https://gemini.google.com/app', reload() {} },
    sessionStorage: {
      getItem: k => (sessionStore.has(k) ? sessionStore.get(k) : null),
      setItem: (k, v) => sessionStore.set(k, v),
    },
    chrome,
    WebSocket: class { constructor() { this.readyState = 0; } send() {} close() {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
  });

  return {
    ports,
    timers,
    fireWindow(type, event) {
      const fns = windowListeners[type] || [];
      fns.forEach(fn => fn(event || { type }));
    },
    portsNamed: (name) => ports.filter(p => p.name === name),
  };
}

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

test('BFCache eviction: the extension acknowledges runtime.lastError instead of logging "Unchecked runtime.lastError"', async () => {
  const env = setupVm();
  await settle();

  const bridge = env.portsNamed('gemini-bridge-socket')[0];
  const coordinator = env.portsNamed('gemini-tab-coordinator')[0];
  assert.ok(bridge, 'bridge port must exist before eviction');
  assert.ok(coordinator, 'coordinator port must exist before eviction');

  const bridgeReads = bridge.kill(
    'The page keeping the extension port is moved into back/forward cache, so the message channel is closed.'
  );
  assert.ok(bridgeReads > 0,
    'chrome.runtime.lastError must be read inside the onDisconnect callback; an unread lastError is what surfaces as "Unchecked runtime.lastError"');

  const coordinatorReads = coordinator.kill(
    'The page keeping the extension port is moved into back/forward cache, so the message channel is closed.'
  );
  assert.ok(coordinatorReads > 0,
    'the coordinator port has the same lastError-acknowledgement requirement');
});

test('BFCache restore rebuilds both ports (timers do not run while the page is frozen)', async () => {
  const env = setupVm();
  await settle();

  const bridgeBefore = env.portsNamed('gemini-bridge-socket').length;
  const coordinatorBefore = env.portsNamed('gemini-tab-coordinator').length;
  assert.ok(bridgeBefore > 0 && coordinatorBefore > 0, 'both ports start connected');

  // Chrome freezes the page: the ports die and the queued retry timers never run.
  env.portsNamed('gemini-bridge-socket').forEach(p => p.kill('moved into back/forward cache'));
  env.portsNamed('gemini-tab-coordinator').forEach(p => p.kill('moved into back/forward cache'));
  const timersQueuedWhileFrozen = env.timers.length;

  // The user navigates back: pagehide/persisted -> pageshow/persisted.
  env.fireWindow('pagehide', { type: 'pagehide', persisted: true });
  env.fireWindow('pageshow', { type: 'pageshow', persisted: true });
  await settle();

  assert.ok(env.portsNamed('gemini-bridge-socket').length > bridgeBefore,
    'a BFCache restore must re-open the bridge port — the setTimeout retry queued while frozen never fires');
  assert.ok(env.portsNamed('gemini-tab-coordinator').length > coordinatorBefore,
    'a BFCache restore must re-open the coordinator port too');
  assert.ok(timersQueuedWhileFrozen > 0,
    'sanity: the disconnect handlers really did queue timer-based retries that BFCache suppresses');
});

test('a normal unload (persisted=false) does not attempt a BFCache-style rebuild', async () => {
  const env = setupVm();
  await settle();
  const bridgeBefore = env.portsNamed('gemini-bridge-socket').length;

  // beforeunload/pagehide without persisted === true means the page is really
  // going away; opening new ports there is pointless work.
  env.fireWindow('beforeunload', { type: 'beforeunload' });
  env.fireWindow('pagehide', { type: 'pagehide', persisted: false });
  await settle();

  assert.equal(env.portsNamed('gemini-bridge-socket').length, bridgeBefore,
    'a real unload must not spawn new ports');
});
