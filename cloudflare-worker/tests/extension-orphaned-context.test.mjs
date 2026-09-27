import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../extension-cloudflare/content.js', import.meta.url), 'utf8');

/**
 * Minimal sandbox in the shape the other content.js tests use. `runtime` is
 * configurable so each test can model a different extension state:
 *   undefined                       -> no extension APIs at all (plain web)
 *   {} (no id)                      -> orphaned context (extension reloaded)
 *   { id, connect() throws }        -> live context whose background port fails
 */
function setupVm({ runtime, extraGlobals = {} } = {}) {
  const sockets = [];
  const timers = [];
  const pills = [];

  const node = () => {
    const listeners = {};
    const el = { innerText: '', textContent: '', style: {}, classList: { contains: () => false },
      getAttribute: () => null, querySelector: () => null, remove() {},
      listeners,
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      _html: '' };
    el.innerHTML = '';
    Object.defineProperty(el, 'innerHTML', {
      get() { return el._html; },
      set(value) { el._html = value; }
    });
    return el;
  };

  const document = {
    querySelectorAll: () => [],
    querySelector: () => node(),
    createElement: () => { const el = node(); pills.push(el); return el; },
    body: { appendChild() {} },
    head: { appendChild() {} },
    addEventListener() {}
  };

  class WebSocketMock {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    constructor(url) { this.url = url; sockets.push(this); }
    send() {}
    close(code) { this.readyState = 3; this.onclose?.({ code: code || 1000 }); }
  }

  const chrome = {
    storage: {
      sync: { get: async () => ({ workerUrl: 'https://worker.test', bridgeToken: 'test-secret' }) },
      local: { get: (_k, cb) => cb?.({}), set: (_o, cb) => cb?.(), remove: (_k, cb) => cb?.() },
      onChanged: { addListener() {} }
    }
  };
  if (runtime) chrome.runtime = runtime;

  vm.runInNewContext(source, {
    console: { log() {}, warn() {}, error() {} },
    URL, Map, Array, Boolean,
    document,
    window: { addEventListener() {}, postMessage() {} },
    WebSocket: WebSocketMock,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    ...extraGlobals,
    chrome
  });

  return {
    sockets,
    timers,
    pills,
    // The status pill is the only element the content script attaches a click
    // handler to; find it the same way the page would and fire that handler.
    clickPill() {
      const pill = pills.find(p => p.listeners && p.listeners.click && p.listeners.click.length);
      if (!pill) return false;
      pill.listeners.click.forEach(fn => fn());
      return true;
    }
  };
}

// Drain the microtask queue, not just one tick: init awaits chrome.storage
// before it reaches the transport decision.
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

test('orphaned extension context never opens a direct WebSocket and asks for a tab reload', async () => {
  const { sockets, pills } = setupVm({
    runtime: {
      getURL: p => p,
      // Exactly what Chrome throws once the context is invalidated.
      connect: () => { throw new Error('Extension context invalidated'); }
    }
  });
  await settle();

  assert.equal(sockets.length, 0,
    'an orphaned content script must not open a WebSocket — it races live tabs for the worker lease');
  assert.ok(pills.some(p => p.innerHTML.includes('Reload tab')),
    'the orphaned tab must tell the user that reloading the tab is the fix');
});

test('a live extension keeps the direct WebSocket disabled and retries the background port', async () => {
  const { sockets, timers } = setupVm({
    runtime: {
      id: 'live-extension-id',
      getURL: p => p,
      connect: () => { throw new Error('background bridge unavailable'); }
    }
  });
  await settle();

  assert.equal(sockets.length, 0,
    'direct WebSocket stays disabled while the extension context is alive');
  assert.ok(timers.length > 0,
    'a broken background port is retried rather than replaced by a direct WebSocket');
});

test('clicking the reload hint on an orphaned tab reloads the page instead of retrying', async () => {
  let reloads = 0;
  const env = setupVm({
    runtime: {
      getURL: p => p,
      connect: () => { throw new Error('Extension context invalidated'); }
    },
    extraGlobals: {
      location: { pathname: '/app', reload: () => { reloads++; } }
    }
  });
  await settle();

  assert.equal(reloads, 0, 'nothing reloads on its own');
  assert.equal(env.clickPill(), true, 'the status pill must be clickable');

  assert.equal(reloads, 1, 'a page reload is the only cure for an orphaned context');
  assert.equal(env.sockets.length, 0, 'and clicking it must still never open a WebSocket');
});

test('without an extension context the direct WebSocket fallback still works', async () => {
  const { sockets } = setupVm();
  await settle();

  assert.equal(sockets.length, 1,
    'a page without extension APIs keeps the direct WebSocket transport');
  assert.equal(new URL(sockets[0].url).searchParams.get('token'), 'test-secret');
});
