import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STALE_AFTER_MS, PONG_GRACE_MS, isKeepaliveMissed, isEvictable } from '../src/liveness.js';
import { CLIENT_STALE_SOCKET_IDLE_MS } from '../../extension-cloudflare/background.js';

const NOW = 1_800_000_000_000;
const OPEN = { readyState: 1 }; // 1 = WebSocket.OPEN

const workerSrc = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

test('recording a connection arms the alarm', () => {
  // KAN-168. The alarm was only armed from the constructor, from inside
  // alarm() itself, and around generation — never when a client connected.
  // So if the one alarm the constructor armed fired while nothing was
  // connected, the re-arm was skipped and the alarm was dead for good: no
  // keepalive PING, no stale sweep, no MCP keepalive, until the next deploy.
  //
  // Production measured exactly that (2026-09-27): zero MCP keepalives across
  // a 231s stream that was demonstrably live, a connection 209s past the 180s
  // stale threshold and never reaped, `idle` climbing monotonically, and zero
  // alarm invocations in 23 minutes of `wrangler tail`.
  //
  // This asserts the arm happens inside recordConnection(), not merely that
  // scheduleAlarm() exists somewhere in the file.
  const body = /recordConnection\(instanceId, socket\)\s*\{[\s\S]*?\n  \}/.exec(workerSrc);
  assert.ok(body, 'recordConnection() must still exist in src/index.js');
  assert.match(
    body[0],
    /this\.scheduleAlarm\(/,
    'recordConnection() must arm the alarm — without it a connection arriving ' +
      'after a skipped re-arm leaves the DO permanently without a keepalive'
  );
});

test('the client stale threshold exceeds the DO keepalive interval', () => {
  // The invariant both sides now depend on. The client tears its own socket
  // down after CLIENT_STALE_SOCKET_IDLE_MS of silence, and the server only
  // PINGs once per IDLE_ALARM_INTERVAL_MS. If the client threshold is not
  // strictly greater, the client closes a healthy socket before the server's
  // PING can ever prove it alive — the KAN-162 flap, and the same class of bug
  // the server hit in KAN-159/KAN-161.
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const interval = Number(/IDLE_ALARM_INTERVAL_MS\s*=\s*(\d+)/.exec(src)[1]);

  assert.ok(
    CLIENT_STALE_SOCKET_IDLE_MS > interval,
    `client stale threshold (${CLIENT_STALE_SOCKET_IDLE_MS}ms) must exceed the DO keepalive interval (${interval}ms)`
  );
  assert.ok(
    STALE_AFTER_MS > interval,
    `server stale threshold (${STALE_AFTER_MS}ms) must exceed the DO keepalive interval (${interval}ms)`
  );
});

test('the client threshold is not the old 60s value that caused the flap', () => {
  // Regression pin: 60_000 was below the 120s keepalive interval, so the
  // client always fired first and the socket was rebuilt roughly every 2 min.
  assert.notEqual(CLIENT_STALE_SOCKET_IDLE_MS, 60_000);
});

test('a connection that answered the keepalive is never swept, however long it has been idle', () => {
  // This is the production failure (2026-09-27): the idle alarm only PINGs every
  // 120s, so a healthy connection is always past the 45s threshold when the
  // sweep runs, and the sweep ran in the same tick as the PING.
  const state = {
    socket: OPEN,
    lastActivityAt: NOW - 120_000,
    lastPingAt: NOW - 1_000,
    lastPongAt: NOW - 900
  };
  assert.equal(isKeepaliveMissed(state, NOW), false);
  assert.equal(isEvictable(state, NOW), false, 'a responsive connection must survive an idle sweep');
});

test('a connection that ignores the keepalive is swept once the grace window passes', () => {
  const state = {
    socket: OPEN,
    // Idle past the stale threshold AND past the keepalive grace: both conditions
    // are required before eviction, so a dead connection is only reaped once it
    // has also been quiet for longer than one alarm cycle.
    lastActivityAt: NOW - (STALE_AFTER_MS + 1),
    lastPingAt: NOW - 45_000,
    lastPongAt: NOW - 200_000
  };
  assert.equal(isKeepaliveMissed(state, NOW), true);
  assert.equal(isEvictable(state, NOW), true, 'an unresponsive connection must still be reaped');
});

test('a connection that answers the keepalive survives even when very long idle', () => {
  // The KAN-161 regression: the idle alarm only PINGs every 120s, so a healthy
  // connection is always past the stale threshold when the sweep runs. It must
  // not be swept for that reason alone.
  const state = {
    socket: OPEN,
    lastActivityAt: NOW - (STALE_AFTER_MS + 60_000),
    lastPingAt: NOW - 45_000,
    lastPongAt: NOW - 44_000
  };
  assert.equal(
    isEvictable(state, NOW),
    false,
    'a responsive connection must never be evicted on raw idle time alone'
  );
});

test('a socket that is no longer OPEN counts as dead whatever the timestamps say', () => {
  const state = {
    socket: { readyState: 3 },
    lastActivityAt: NOW - 500,
    lastPingAt: NOW - 500,
    lastPongAt: NOW - 400
  };
  assert.equal(isKeepaliveMissed(state, NOW), true);
  assert.equal(isEvictable(state, NOW), true);
});

test('recent traffic keeps a connection alive even before any keepalive exchange', () => {
  const state = { socket: OPEN, lastActivityAt: NOW - 5_000, lastPingAt: 0, lastPongAt: 0 };
  assert.equal(isKeepaliveMissed(state, NOW), false, 'no PING sent yet means no missed keepalive');
  assert.equal(isEvictable(state, NOW), false);
});

test('a connection pinged in this very tick is protected until the PONG can arrive', () => {
  const state = {
    socket: OPEN,
    lastActivityAt: NOW - 120_000,
    lastPingAt: NOW,
    lastPongAt: NOW - 120_000
  };
  assert.equal(isKeepaliveMissed(state, NOW), false, 'the PING just went out; give the PONG a chance');
  assert.equal(
    isKeepaliveMissed(state, NOW + PONG_GRACE_MS + 1),
    true,
    'unanswered past the grace window it is dead'
  );
});

test('a quiet connection that was never probed falls back to the idle threshold', () => {
  const quiet = { socket: OPEN, lastActivityAt: NOW - 30_000, lastPingAt: 0, lastPongAt: 0 };
  assert.equal(isEvictable(quiet, NOW), false);
  const forgotten = {
    socket: OPEN,
    lastActivityAt: NOW - (STALE_AFTER_MS + 1),
    lastPingAt: 0,
    lastPongAt: 0
  };
  assert.equal(isEvictable(forgotten, NOW), true);
});

test('the grace window fits inside the idle alarm cadence', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const idleAlarm = /IDLE_ALARM_INTERVAL_MS\s*=\s*(\d+)/.exec(source);
  assert.ok(idleAlarm, 'IDLE_ALARM_INTERVAL_MS must still exist');
  assert.ok(
    PONG_GRACE_MS < Number(idleAlarm[1]),
    'the PONG grace must be shorter than the idle alarm interval, otherwise a missed keepalive is undetectable'
  );
});

test('the stale threshold sits ABOVE the idle alarm interval (the KAN-161 invariant)', () => {
  // This is the bug that made the production lease flap. The keepalive only PINGs
  // once per alarm tick, so a healthy idle connection is always past the stale
  // threshold when the sweep runs. If the threshold is below the alarm interval,
  // raw-idle time can never distinguish "quiet but answering" from "dead".
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const idleAlarm = /IDLE_ALARM_INTERVAL_MS\s*=\s*(\d+)/.exec(source);
  const staleStatic = /STALE_SOCKET_IDLE_MS\s*=\s*(\d+)/.exec(source);
  const staleInstance = /this\.STALE_CONNECTION_TIMEOUT_MS\s*=\s*(\d+)/.exec(source);

  assert.ok(idleAlarm && staleStatic && staleInstance, 'all three thresholds must still exist');
  const idle = Number(idleAlarm[1]);
  assert.ok(
    Number(staleStatic[1]) > idle,
    `STALE_SOCKET_IDLE_MS (${staleStatic[1]}) must exceed IDLE_ALARM_INTERVAL_MS (${idle})`
  );
  assert.ok(
    Number(staleInstance[1]) > idle,
    `STALE_CONNECTION_TIMEOUT_MS (${staleInstance[1]}) must exceed IDLE_ALARM_INTERVAL_MS (${idle}) — this is the value the eviction code actually reads`
  );
  assert.equal(
    Number(staleInstance[1]),
    STALE_AFTER_MS,
    'the DO threshold and src/liveness.js STALE_AFTER_MS must not drift apart'
  );
});
