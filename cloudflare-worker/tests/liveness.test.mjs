import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STALE_AFTER_MS, PONG_GRACE_MS, isKeepaliveMissed, isEvictable } from '../src/liveness.js';

const NOW = 1_800_000_000_000;
const OPEN = { readyState: 1 }; // 1 = WebSocket.OPEN

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
    lastActivityAt: NOW - 120_000,
    lastPingAt: NOW - 45_000,
    lastPongAt: NOW - 200_000
  };
  assert.equal(isKeepaliveMissed(state, NOW), true);
  assert.equal(isEvictable(state, NOW), true, 'an unresponsive connection must still be reaped');
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
