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
 * ── Secret redaction ────────────────────────────────────────────────────────
 *
 * The service worker logs its own WebSocket URL, and that URL carries the
 * bridge auth token as a query parameter:
 *
 *     wss://…/bridge?token=<BRIDGE_SECRET>&instanceId=…
 *
 * wrangler tail has the same exposure: it redacts instanceId but leaves token=
 * in plain text. Anything that prints these URLs — this script, tail output
 * pasted into a ticket, a CI log — can therefore leak a live credential. A
 * token in a committed file or a public issue is a leaked token; see
 * cloudflare-worker/wrangler.toml, which refuses to hold one for exactly this
 * reason.
 *
 * So every line printed here is scrubbed before it reaches stdout. The
 * instanceId is redacted too, since it identifies a browser install.
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

/**
 * Scrub credentials out of anything about to be printed.
 *
 * The SW logs its own socket URL, which carries the bridge auth token. The
 * token can appear as a query parameter in any case, and as a bare value when
 * the URL has been URL-encoded or split across an object dump, so both shapes
 * are covered:
 *
 *   ?token=<value>        → ?token=REDACTED
 *   "token":"<value>"     → "token":"REDACTED"
 *   Authorization: Bearer <value>   → …Bearer REDACTED
 *
 * instanceId is redacted as well: it is a stable per-browser-install
 * identifier, and it is not useful when reading a console log.
 */
export function redact(line) {
  return String(line)
    // Query parameters, wherever the parameter starts. Matching only on a
    // leading ? or & misses `token=<value>` in a bare parameter list, a log
    // line that has been split, or an object dumped without its URL — which
    // is exactly the case that leaks. The value stops at &, whitespace, a
    // quote, or end of line, so a following parameter survives intact.
    .replace(
      /\b(token|access_token|auth|api_key|apikey)=[^&\s"'\\]+/gi,
      '$1=REDACTED'
    )
    .replace(
      /("(?:token|access_token|auth|api_key|apikey)"\s*:\s*")[^"]*(")/gi,
      '$1REDACTED$2'
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1REDACTED')
    .replace(/\binstanceId=[^&\s"'\\]+/gi, 'instanceId=REDACTED')
    .replace(
      /("(?:instanceId|clientId)"\s*:\s*")[^"]*(")/gi,
      '$1REDACTED$2'
    );
}

/** Single exit point for output, so no print site can forget to scrub. */
const say = (...parts) => console.log(redact(parts.join(' ')));

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
  // w.url is a chrome-extension:// URL, not a socket URL, so it carries no
  // token — but it does identify the installed extension, and this script is
  // run against someone's real browser. Scrub it anyway: the cost is zero and
  // a redaction rule that only fires on today's URL shape is a rule that fails
  // the first time Chrome changes it.
  for (const w of workers) console.error(redact('  ' + w.url));
  process.exit(1);
}

for (const w of picked) console.error(redact(`[attach] ${w.url}`));

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
      say(`${new Date(timestamp).toISOString()} [${type}] ${text}`);
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      // Log.Entry.timestamp is also milliseconds since epoch.
      say(
        `${new Date(e.timestamp).toISOString()} [log/${e.level}] ${e.text}` +
          (e.url ? ` (${e.url})` : '')
      );
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      say(`[exception] ${d.text} ${d.exception?.description || ''}`);
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
