/**
 * KAN-162: pins the extension's 409-conflict retry against the DO's real
 * eviction conditions.
 *
 * The failure this exists to prevent: background.js hardcoded a 50s conflict
 * retry because a comment claimed the DO had a "45-second stale-connection
 * window". KAN-161 moved that window to 180s, so a 50s retry kept hitting a
 * still-healthy prior connection and collected another 409 — once per retry,
 * for the whole 180s window. The value was correct-by-coincidence when it was
 * written, and silently wrong the moment the server changed.
 *
 * The two sides cannot share an import: the extension ships as
 * extension-cloudflare/ copied verbatim (scripts/build-extension.py), while
 * the worker is bundled by wrangler from cloudflare-worker/src/. These tests
 * are the seam — they read the worker's constants and fail if the extension
 * drifts from them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isEvictable, PONG_GRACE_MS, STALE_AFTER_MS } from '../src/liveness.js';
import {
  CLIENT_STALE_SOCKET_IDLE_MS,
  CONFLICT_RETRY_DELAY_MS,
  DO_PONG_GRACE_MS,
  DO_STALE_CONNECTION_TIMEOUT_MS,
} from '../../extension-cloudflare/background.js';

const NOW = 1_800_000_000_000;
const OPEN = { readyState: 1 }; // 1 = WebSocket.OPEN

const workerSource = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const extensionSource = fs.readFileSync(new URL('../../extension-cloudflare/background.js', import.meta.url), 'utf8');

/** The value the 409 guard actually reads, not a dead duplicate. */
function workerStaleTimeout() {
  const m = /this\.STALE_CONNECTION_TIMEOUT_MS\s*=\s*(\d+)/.exec(workerSource);
  assert.ok(m, 'this.STALE_CONNECTION_TIMEOUT_MS must still exist in src/index.js');
  return Number(m[1]);
}

test('the extension 409 retry is not shorter than the server stale threshold', () => {
  // THE invariant. This is the assertion that would have caught the bug: a
  // retry fired before the DO is willing to evict the prior instance cannot
  // succeed, so it is not a retry, it is a faster way to collect another 409.
  const server = workerStaleTimeout();
  assert.ok(
    CONFLICT_RETRY_DELAY_MS >= server,
    `extension 409 retry (${CONFLICT_RETRY_DELAY_MS}ms) must be at least the server stale threshold (${server}ms); ` +
      'a shorter retry re-hits a still-healthy connection and 409s again'
  );
});

test('the extension 409 retry also clears the keepalive PONG grace', () => {
  // The stale threshold is necessary but not sufficient. Since KAN-161 the DO
  // evicts on a missed keepalive, so the retry must additionally wait out
  // PONG_GRACE_MS — otherwise it can land while a recent PING is still within
  // its grace window and the connection is judged healthy.
  const server = workerStaleTimeout();
  assert.ok(
    CONFLICT_RETRY_DELAY_MS >= server + PONG_GRACE_MS,
    `extension 409 retry (${CONFLICT_RETRY_DELAY_MS}ms) must clear the stale threshold plus the PONG grace (${server + PONG_GRACE_MS}ms)`
  );
});

test('the extension mirrors of the server constants are exact, not approximate', () => {
  assert.equal(
    DO_STALE_CONNECTION_TIMEOUT_MS,
    workerStaleTimeout(),
    'DO_STALE_CONNECTION_TIMEOUT_MS must equal the worker threshold it claims to mirror'
  );
  assert.equal(
    DO_PONG_GRACE_MS,
    PONG_GRACE_MS,
    'DO_PONG_GRACE_MS must equal PONG_GRACE_MS in src/liveness.js'
  );
  assert.equal(
    DO_STALE_CONNECTION_TIMEOUT_MS,
    STALE_AFTER_MS,
    'the extension mirror and src/liveness.js STALE_AFTER_MS must not drift apart'
  );
});

test('the client idle threshold is not below the threshold it must outlast', () => {
  // The client must not call its own socket dead while the server still
  // considers the same connection healthy, or the two sides tear down and
  // rebuild in lockstep (the KAN-162 flap).
  assert.ok(
    CLIENT_STALE_SOCKET_IDLE_MS >= DO_STALE_CONNECTION_TIMEOUT_MS,
    `client idle threshold (${CLIENT_STALE_SOCKET_IDLE_MS}ms) must not fire before the server gives up on the connection (${DO_STALE_CONNECTION_TIMEOUT_MS}ms)`
  );
});

test('a retry at CONFLICT_RETRY_DELAY_MS actually clears the prior connection', () => {
  // Not just an arithmetic comparison — simulate the state the DO would hold
  // for a prior instance that stopped answering, and prove isEvictable agrees
  // that the slot is free by the time the client retries. `lastActivityAt` is
  // set to the instant of the 409, i.e. the worst case: the prior connection
  // died just now, so the client waits the full delay from that point.
  const at409 = { socket: OPEN, lastActivityAt: NOW, lastPingAt: NOW, lastPongAt: 0 };

  assert.equal(
    isEvictable(at409, NOW + CONFLICT_RETRY_DELAY_MS - 1, { staleAfterMs: DO_STALE_CONNECTION_TIMEOUT_MS }),
    true,
    'sanity: the connection that ignored the 409 is genuinely evictable after the wait'
  );
  assert.equal(
    isEvictable(at409, NOW + DO_STALE_CONNECTION_TIMEOUT_MS - 1, { staleAfterMs: DO_STALE_CONNECTION_TIMEOUT_MS }),
    false,
    'a retry before the stale threshold is refused — this is exactly the 50s bug'
  );
  assert.equal(
    isEvictable(at409, NOW + CONFLICT_RETRY_DELAY_MS, { staleAfterMs: DO_STALE_CONNECTION_TIMEOUT_MS }),
    true,
    `the retry at CONFLICT_RETRY_DELAY_MS (${CONFLICT_RETRY_DELAY_MS}ms) must land after the DO would evict`
  );
});

test('the old 50s hardcoded retry is gone from the extension source', () => {
  // Regression pin on the exact literal, so the value cannot quietly come back
  // as a magic number that no test derives from the server.
  assert.ok(
    !/CONFLICT_RETRY_DELAY_MS\s*=\s*50_000/.test(extensionSource),
    'the 50_000 literal must not reappear; the delay is derived from the mirrored server constants'
  );
  // Scoped to the live _onConflict body. The docblock above the constant
  // deliberately quotes the old 45s wording to record what the bug was, so a
  // whole-file scan would flag the explanation as the regression.
  const handler = /\/\*\*(?:(?!\*\/)[\s\S])*?\*\/\s*_onConflict\(\)\s*\{[\s\S]*?\n  \}/.exec(extensionSource);
  assert.ok(handler, 'could not locate the _onConflict handler in background.js');
  assert.ok(
    !/45-second stale-connection window|45s stale window|50_000/.test(handler[0]),
    'the misleading 45-second stale-window comment must not come back in _onConflict'
  );
  assert.match(
    handler[0],
    /CONFLICT_RETRY_DELAY_MS/,
    '_onConflict must use the derived CONFLICT_RETRY_DELAY_MS, not a local literal'
  );
});
