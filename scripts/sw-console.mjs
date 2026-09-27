#!/usr/bin/env node3
/**
 * sw-console.mjs — read a Chrome MV3 service worker's console over CDP.
 *
 * Why this exists: a service worker runs in its own execution context, so its
 * console.log never appears in a page's DevTools console, and page-level
 * automation (Kapture, chrome-devtools MCP) can only see the tab. This attaches
 * to the `service_worker` target directly and streams its console.
 *
 * Usage:
 *   node sw-console.mjs <debugPort> [urlSubstring] [seconds]
 *
 *   node sw-console.mjs 9333 swtest 5      # probe instance, watch 5s
 *   node sw-console.mjs 9222 dnapdkmdpjh   # the real bridge extension
 *
 * Requires Chrome to be started with --remote-debugging-port=<debugPort>.
 *
 * ── Operational notes (learned the hard way, 2026-09-27) ────────────────────
 *
 * 1. Chrome 137+ ignores --load-extension. You cannot seed a throwaway profile
 *    with the extension from the command line. To test this script you either
 *    load the extension by hand into the profile Chrome opens, or run against
 *    the real browser (see 2).
 *
 * 2. NEVER run this against a throwaway profile while the real browser is
 *    connected. Both extensions then hold the same Durable Object slot: the DO
 *    admits one connection and 409s the other. The symptom is a client that
 *    connects, gets evicted, and then retries into 409 forever — which looks
 *    exactly like a client bug and is not one. Use the real browser.
 *
 * 3. If Chrome 137+ also blocks this, the user's own
 *    scripts/chrome-dev-shortcut.command launches Chrome with an isolated
 *    profile and remote debugging. It is untracked; do not assume it is safe to
 *    delete.
 */
const port = process.argv[2] || '9222';
const match = process.argv[3] || '';
const seconds = Number(process.argv[4] || 10);
const base = `http://127.0.0.1:${port}`;

const res = await fetch(`${base}/json/list`);
const targets = await res.json();

const workers = targets.filter((t) => t.type === 'service_worker');
if (workers.length === 0) {
  console.error('No service_worker targets found. Is --remote-debugging-port set?');
  process.exit(1);
}

const picked = match
  ? workers.filter((w) => w.url.includes(match))
  : workers;

if (picked.length === 0) {
  console.error(`No service worker matched "${match}". Available:`);
  for (const w of workers) console.error('  ' + w.url);
  process.exit(1);
}

for (const w of picked) console.error(`[attach] ${w.url}`);

const deadline = Date.now() + seconds * 1000;

// Attach to every matched worker; each gets its own WebSocket.
const sockets = picked.map((w) => new WebSocket(w.webSocketDebuggerUrl));
let nextId = 1;
const send = (ws, method, params = {}) =>
  ws.send(JSON.stringify({ id: nextId++, method, params }));

const pending = new Set();

for (const ws of sockets) {
  ws.addEventListener('open', () => {
    send(ws, 'Runtime.enable');
    send(ws, 'Log.enable');
    // Replay whatever the worker already logged before we attached.
    send(ws, 'Runtime.evaluate', { expression: 'void 0' });
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.id && pending.has(msg.id)) pending.delete(msg.id);

    if (msg.method === 'Runtime.consoleAPICalled') {
      const { type, args = [], timestamp } = msg.params;
      const text = args
        .map((a) => (a.value !== undefined ? a.value : a.description || a.type))
        .join(' ');
      // Runtime.Timestamp is milliseconds since epoch (already ms — do not scale).
      console.log(`${new Date(timestamp).toISOString()} [${type}] ${text}`);
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      // Log.Entry.timestamp is also milliseconds since epoch.
      console.log(
        `${new Date(e.timestamp).toISOString()} [log/${e.level}] ${e.text}` +
          (e.url ? ` (${e.url})` : '')
      );
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      console.log(`[exception] ${d.text} ${d.exception?.description || ''}`);
    }
  });
}

// Keep the process alive until the deadline, then exit cleanly.
const timer = setInterval(() => {
  if (Date.now() > deadline) {
    clearInterval(timer);
    for (const ws of sockets) ws.close();
    process.exit(0);
  }
}, 200);
