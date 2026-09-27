// Connection liveness rules for the Bridge Durable Object.
//
// The DO used to call a connection "stale" from raw idle time alone
// (now - lastActivityAt > 45s). That is wrong whenever the keepalive cadence is
// longer than the threshold: the idle alarm only PINGs every
// IDLE_ALARM_INTERVAL_MS (120s), so a perfectly healthy but idle connection is
// always past 45s by the time the sweep runs — and the sweep runs in the same
// tick as the PING, long before the PONG can come back. Production showed
// exactly that on 2026-09-27: idle climbed 26s -> 56s -> 86s, the socket was
// closed, the epoch bumped, and it repeated every ~107s with a single
// connection and no contention.
//
// Liveness is therefore "did it answer the keepalive we sent", not "how long has
// it been quiet". Both predicates are pure so they can be unit tested without
// the workers runtime.

/**
 * Idle time after which a connection is suspect — but only if it also missed a
 * keepalive.
 *
 * 180s, not 45s, and the margin over IDLE_ALARM_INTERVAL_MS (120s) is the whole
 * point: the keepalive only PINGs once per alarm tick, so a healthy connection
 * is ALWAYS idle past any threshold below ~120s when the sweep runs. At 45s the
 * raw-idle fallback could not distinguish "quiet but answering" from "dead", and
 * on a DO that has just accepted a connection the never-probed branch could
 * evict a socket that was merely younger than one alarm cycle.
 */
export const STALE_AFTER_MS = 180000;

/**
 * How long a connection may take to answer a PING before it counts as missed.
 * Comfortably above a real network round trip, and far below the 120s idle
 * alarm cadence, so one unanswered round trip is always detectable.
 */
export const PONG_GRACE_MS = 30000;

/**
 * True when the latest keepalive PING went unanswered for longer than the
 * grace window, or when the socket is no longer OPEN.
 */
export function isKeepaliveMissed(state, now, { graceMs = PONG_GRACE_MS } = {}) {
  if (!state) return true;
  // A socket that is not OPEN cannot be alive whatever the timestamps say.
  if (state.socket && state.socket.readyState !== undefined && state.socket.readyState !== 1) return true;
  if (!state.lastPingAt) return false; // nothing sent yet, so nothing was missed
  if (state.lastPongAt && state.lastPongAt >= state.lastPingAt) return false; // answered
  return (now - state.lastPingAt) > graceMs;
}

/**
 * True when another instance may take the slot: the connection either missed a
 * keepalive, or it has been quiet past the threshold and was never probed.
 */
export function isEvictable(state, now, { staleAfterMs = STALE_AFTER_MS, graceMs = PONG_GRACE_MS } = {}) {
  if (!state) return false;
  // A socket that is not OPEN holds nothing: keeping the entry would only make
  // the next instance collide with a dead record.
  if (state.socket && state.socket.readyState !== undefined && state.socket.readyState !== 1) return true;
  const lastActivityAt = typeof state.lastActivityAt === "number" ? state.lastActivityAt : now;
  if (now - lastActivityAt <= staleAfterMs) return false; // recent traffic proves liveness
  if (!state.lastPingAt) return true; // quiet and never probed (legacy entries)
  return isKeepaliveMissed(state, now, { graceMs });
}
