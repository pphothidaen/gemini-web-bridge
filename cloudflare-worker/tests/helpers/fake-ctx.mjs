// Test double for the Durable Object context.
//
// KAN-168: these tests used to construct the DO with a bare `{}` as ctx, which
// worked only because scheduleAlarm() wrote to `ctx.alarm` — a property that
// does not exist on DurableObjectState, so assigning to it needed nothing from
// ctx at all. The real API is `ctx.storage.setAlarm(Date.now() + ms)`, so a
// realistic ctx is now required to construct the DO at all.
//
// Only the surface scheduleAlarm() actually touches is implemented. Everything
// else stays absent on purpose: a test that quietly starts depending on real
// storage behaviour should fail loudly rather than pass against a permissive
// stub.

/**
 * A ctx good enough to construct GeminiBridgeDO and exercise its alarm paths.
 *
 * `setAlarm` records what was armed and resolves, mirroring the real API's
 * async signature. `getAlarm` returns the pending time, as the real one does.
 *
 * @param {object} [opts]
 * @param {() => number} [opts.now] injectable clock, for a test that asserts
 *                                   the exact scheduled fire time
 */
export function makeCtx(opts = {}) {
  const now = opts.now || Date.now;
  const calls = { setAlarm: [], getAlarm: [] };
  let pending = null;

  return {
    // The members GeminiBridgeDO reads in its constructor and alarm paths.
    // Deliberately not stubbed: props, facets, acceptWebSocket, exports, abort.
    storage: {
      async setAlarm(scheduledTime) {
        const at = typeof scheduledTime === 'number' ? scheduledTime : scheduledTime.getTime();
        calls.setAlarm.push(at);
        pending = at;
      },
      async getAlarm() {
        calls.getAlarm.push(now());
        return pending;
      },
      async deleteAlarm() {
        pending = null;
      }
    },
    id: { toString: () => 'test-do-id' },
    waitUntil() {},
    blockConcurrencyWhile: (fn) => fn(),

    // Test-only views, so a test can assert the cadence without reaching into
    // DO internals.
    __calls: calls,
    __pendingAlarm: () => pending
  };
}
