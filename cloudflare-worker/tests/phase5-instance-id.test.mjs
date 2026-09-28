/**
 * Phase 5 Integration Tests: Instance ID Tracking + 409 Conflict Matrix
 *
 * Tests TS-005, TS-007, and TS-012 from PHASE5_INTEGRATION_TEST_ROLLOUT.json
 * against the production worker (no staging available — production only).
 *
 * These are the critical tests for verifying the WebSocket 409 fix:
 * - TS-005: Same instance reconnect is ACCEPTED (not 409)
 * - TS-007: Different instance + healthy old → 409 GENUINE conflict
 * - TS-012: Full 409 decision matrix (5 rows)
 *
 * Run with:
 *   doppler run --project gemini-web-bridge --config prd_worker -- \
 *     env WORKER_URL=https://prod.gemini-web-bridge.workers.dev \
 *     node --test tests/phase5-instance-id.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';

const WORKER_URL = process.env.WORKER_URL || 'https://prod.gemini-web-bridge.workers.dev';
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || '';

// These tests take the single-instance lease and hold it, so they can knock a
// real user's bridge offline. That happened while verifying the other fixes in
// this suite: the lease looked free (the extension was mid-reconnect, so the DO
// reported zero connections), the tests connected, and the live extension was
// evicted. It recovered on its own ~30s later, but "recovered on its own" is not
// a safety property.
//
// A /health probe cannot close that race, so require an explicit acknowledgement
// that the target is a host nobody is using. Deliberately NOT defaulted to
// production: WORKER_URL above still points there, so the safe default is to skip.
const ISOLATED = process.env.BRIDGE_PHASE5_TARGET_ISOLATED === '1';

const skip = BRIDGE_SECRET && ISOLATED
  ? false
  : !BRIDGE_SECRET
    ? 'BRIDGE_SECRET not set — Phase 5 live tests not exercised'
    : 'set BRIDGE_PHASE5_TARGET_ISOLATED=1 to confirm no real user depends on this worker — these tests evict a live extension';

// These tests drive the single-instance connection lease. If a real browser
// extension is already connected to the DO, it owns that lease, and the worker
// correctly answers every new instanceId with 409 "Another instance is
// currently active and healthy". The tests would then assert a 101 that the
// production system is right to refuse, and fail for a reason that has
// nothing to do with the code under test.
//
// So check /health first and skip with a truthful reason when the lease is
// taken. Set BRIDGE_PHASE5_ASSUME_FREE_LEASE=1 only when no extension is
// attached (e.g. a dedicated test DO).
let leaseTaken = false;
let leaseDetail = '';
// `isStale` is not evidence that the lease is free. The DO reaps a socket only
// after 45s of silence, and the extension's MV3 service worker can be quiet that
// long between WebSocket frames without being gone. In that window /health
// reports the connection stale while the DO still holds the slot, so a new
// instanceId is treated as a competitor and the real extension is evicted.
// Observed directly on production: a stale-looking connection let a competing
// upgrade through and the live extension dropped to DISCONNECTED (it reconnected
// on its own ~30s later). These tests connect deliberately and repeatedly, so
// they are the most likely to trigger it — treat ANY tracked connection as a
// held lease, stale or not.
async function detectBusyLease() {
  if (process.env.BRIDGE_PHASE5_ASSUME_FREE_LEASE === '1') return;
  try {
    const res = await fetch(`${WORKER_URL}/health`);
    const body = await res.json();
    const it = body?.instance_tracking ?? {};
    const tracked = it.connections ?? [];
    if (tracked.length > 0) {
      leaseTaken = true;
      leaseDetail = tracked
        .map((c) => `${c.instanceId}${c.isStale ? ' (stale)' : ''}`)
        .join(',');
    }
  } catch {
    // /health unreachable — let the tests run and report their own failure.
  }
}

/**
 * Wait until the single-instance connection lease is actually free.
 *
 * A `close()` from a test socket is fire-and-forget: the Durable Object keeps
 * that instance registered until it observes the close (or the 45s stale
 * reaper fires). A fixed sleep is therefore unreliable — it flaked between
 * TS-005, TS-007 and TS-012 depending on which one happened to start while a
 * previous socket was still registered. Poll the real state instead.
 *
 * This is cleanup between tests, not a licence to run. Each test still gates on
 * its own detectBusyLease() check, and there is an unavoidable race: the DO can
 * report no connections during the window where the real extension is
 * reconnecting, and the next test's upgrade then evicts it. That race is why
 * BRIDGE_PHASE5_TARGET_ISOLATED exists — see the note above detectBusyLease().
 */
async function waitForFreeLease(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    leaseTaken = false;
    leaseDetail = '';
    await detectBusyLease();
    if (!leaseTaken) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Connect a WebSocket to /bridge with the given instanceId and token.
 * Returns { ws, promise } where promise resolves on open or rejects on error/close.
 */
function connectBridge(instanceId) {
  const wsUrl = WORKER_URL.replace('https://', 'wss://');
  const params = new URLSearchParams({
    token: BRIDGE_SECRET,
    instanceId,
  });
  const url = `${wsUrl}/bridge?${params.toString()}`;

  // No subprotocol is requested, and that is load-bearing. The worker builds
  // its 101 from a bare WebSocketPair and never echoes
  // Sec-WebSocket-Protocol (0 occurrences in src/index.js). Per RFC 6455 a
  // client that offered subprotocols but receives none must fail the
  // handshake, so requesting one kills every connection here with 1006
  // before a single assertion runs. Verified by A/B: the same URL returns
  // 101 with no subprotocol, and 1006 with either v2 or v3.
  const ws = new WebSocket(url);

  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`WebSocket connection timeout for instanceId=${instanceId}`));
    }, 10000);

    ws.onopen = () => {
      clearTimeout(timeout);
      resolve({ ws, connected: true });
    };
    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error for instanceId=${instanceId}: ${err.message || err}`));
    };
    ws.onclose = (event) => {
      clearTimeout(timeout);
      // Only reject if the promise hasn't resolved yet
      let resolved = false;
      const origResolve = resolve;
      resolve = (value) => {
        if (!resolved) {
          resolved = true;
          origResolve(value);
        }
      };
    };
  });

  return { ws, promise };
}

/**
 * Try to connect and return the HTTP status code.
 * If the WebSocket handshake fails (e.g. 409), the onclose event
 * will have the status code in event.code.
 */
/**
 * Probe the /bridge guard over plain HTTP rather than the WebSocket API.
 *
 * This exists because the 409 Conflict is not observable over a WebSocket.
 * When the DO refuses a handshake it returns an ordinary HTTP Response with
 * status 409, but a client using new WebSocket() can only ever observe
 * close code 1006 — the browser never surfaces the handshake status.
 * Verified against production: a WebSocket client sees 1006 for the exact
 * request where curl sees 409 "Conflict: Another instance is currently
 * active and healthy".
 *
 * So the conflict assertions must use this. Asserting `close code === 409`
 * cannot pass on any version of the server.
 */
async function probeUpgradeStatus(instanceId) {
  const url = `${WORKER_URL}/bridge?token=${encodeURIComponent(BRIDGE_SECRET)}&instanceId=${instanceId}`;
  // No Upgrade header: Node's fetch (undici) refuses to send one — it throws
  // "invalid upgrade header". That is fine, because the 409 guard is evaluated
  // BEFORE the worker checks for Upgrade (index.js returns 409, and only then
  // reaches the 426 "Expected Upgrade: websocket" branch). A plain GET
  // therefore still returns the 409 we want to assert.
  const res = await fetch(url);
  return { status: res.status, body: await res.text() };
}

function connectBridgeWithStatus(instanceId, tokenOverride) {
  const wsUrl = WORKER_URL.replace('https://', 'wss://');
  const params = new URLSearchParams({
    token: tokenOverride ?? BRIDGE_SECRET,
    instanceId,
  });
  const url = `${wsUrl}/bridge?${params.toString()}`;

  return new Promise((resolve) => {
    // No subprotocol is requested, and that is load-bearing. The worker builds
  // its 101 from a bare WebSocketPair and never echoes
  // Sec-WebSocket-Protocol (0 occurrences in src/index.js). Per RFC 6455 a
  // client that offered subprotocols but receives none must fail the
  // handshake, so requesting one kills every connection here with 1006
  // before a single assertion runs. Verified by A/B: the same URL returns
  // 101 with no subprotocol, and 1006 with either v2 or v3.
  const ws = new WebSocket(url);
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        resolve({ status: 'timeout', code: null, ws });
      }
    }, 10000);

    ws.onopen = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ status: 'connected', code: 101, ws });
      }
    };

    ws.onerror = (err) => {
      // Don't resolve here — wait for onclose which has the HTTP status
    };

    ws.onclose = (event) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      // A failed handshake is reported by the WHATWG WebSocket API as close
      // code 1006 ONLY. 1006 is a reserved local value ("abnormal closure")
      // that can never be sent on the wire, so the real HTTP status (401 /
      // 409) is NOT recoverable from this event. The previous comment here
      // claimed otherwise, which made every 409 assertion unreachable.
      //
      // So when the socket never opened, probe the same URL over plain HTTPS
      // to read the status the worker actually returns.
      if (event.code !== 1006) {
        resolve({ status: 'rejected', code: event.code, ws });
        return;
      }
      httpStatusFor(url).then(
        (code) => resolve({ status: code === 101 ? 'connected' : 'rejected', code, ws }),
        () => resolve({ status: 'rejected', code: 1006, ws }),
      );
    };
  });
}

/**
 * Read the real HTTP status the worker returns for a WebSocket upgrade URL.
 *
 * `fetch` cannot be used: undici rejects `Connection: Upgrade` outright
 * (UND_ERR_INVALID_ARG), and stripping the header turns the request into a
 * plain GET that the worker answers differently. So do the upgrade by hand
 * over raw TLS and read the status line, which is exactly what the browser
 * would have seen.
 */
function httpStatusFor(url) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const req =
      `GET ${parsed.pathname}${parsed.search} HTTP/1.1\r\n` +
      `Host: ${parsed.host}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `\r\n`;

    const socket = tls.connect(
      { host: parsed.hostname, port: 443, servername: parsed.hostname },
      () => socket.write(req),
    );
    let buf = '';
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch {}
      resolve(status);
    };
    const timer = setTimeout(() => finish(null), 10000);
    socket.on('data', (d) => {
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
      finish(m ? Number(m[1]) : null);
    });
    socket.on('error', () => finish(null));
  });
}

function uuidv4() {
  return crypto.randomUUID();
}

function sendSessionReady(ws, options = {}) {
  const msg = {
    type: 'SESSION_READY',
    protocolVersion: 3,
    instanceId: options.instanceId || uuidv4(),
    tokens: options.tokens || null,
    scope: options.scope || null,
    activeModel: options.model || 'gemini-2.0-flash-thinking',
    extendedThinking: false,
    dynamicModels: [],
    recommendedModel: 'gemini-2.0-flash-thinking',
  };
  ws.send(JSON.stringify(msg));
}

// ─── TS-005: Same Instance Reconnect ─────────────────────────────────
test('TS-005: Same instanceId reconnect is accepted (not 409)', { skip }, async (t) => {
  await detectBusyLease();
  if (leaseTaken) {
    t.skip('connection lease held by live extension (' + leaseDetail + ') — detach it, or set BRIDGE_PHASE5_ASSUME_FREE_LEASE=1');
    return;
  }
  // Step 1: Connect with instanceId=A
  const instanceId = uuidv4();
  const result1 = await connectBridgeWithStatus(instanceId);
  assert.equal(result1.code, 101, `First connection should succeed (101), got ${result1.code}`);

  // Send SESSION_READY to establish session
  sendSessionReady(result1.ws, { instanceId, tokens: { bridge: BRIDGE_SECRET } });

  // Give the server a moment to process SESSION_READY
  await new Promise(r => setTimeout(r, 500));

  // Step 2: Close first connection
  result1.ws.close(1000, 'Testing same-instance reconnect');

  // Wait for close to propagate
  await new Promise(r => setTimeout(r, 1000));

  // Step 3: Reconnect with SAME instanceId
  const result2 = await connectBridgeWithStatus(instanceId);
  assert.equal(result2.code, 101,
    `Reconnect with same instanceId should be accepted (101), got ${result2.code}`);

  // Cleanup
  if (result2.ws) result2.ws.close(1000, 'Test complete');
  // Release the shared lease before the next test starts.
  await waitForFreeLease();

  console.log('  ✅ TS-005: Same-instance reconnect accepted (101), not 409');
});

// ─── TS-007: Different Instance + Healthy Old → 409 ──────────────────
test('TS-007: Different instanceId + healthy old connection → 409', { skip }, async (t) => {
  await detectBusyLease();
  if (leaseTaken) {
    t.skip('connection lease held by live extension (' + leaseDetail + ') — detach it, or set BRIDGE_PHASE5_ASSUME_FREE_LEASE=1');
    return;
  }
  // Step 1: Connect with instanceId=A and keep it healthy
  const instanceIdA = uuidv4();
  const resultA = await connectBridgeWithStatus(instanceIdA);
  assert.equal(resultA.code, 101, `First connection should succeed, got ${resultA.code}`);

  // Send SESSION_READY to establish session
  sendSessionReady(resultA.ws, { instanceId: instanceIdA, tokens: { bridge: BRIDGE_SECRET } });
  await new Promise(r => setTimeout(r, 500));

  // Step 2: Try to connect with DIFFERENT instanceId=B (same token).
  // Probed over HTTP, not WebSocket: the 409 is a handshake response and the
  // WebSocket API cannot report it (see probeUpgradeStatus).
  const instanceIdB = uuidv4();
  const resultB = await probeUpgradeStatus(instanceIdB);

  // Expected: 409 Conflict (genuine conflict — different device, healthy old connection)
  assert.equal(resultB.status, 409,
    `Different instanceId with healthy old conn should get 409, got ${resultB.status} (${resultB.body.slice(0, 60)})`);

  // Step 3: Verify original connection A is still healthy and active
  // (send a message and see if we get a response)
  assert.equal(resultA.ws.readyState, 1, 'Original connection A should still be OPEN (readyState=1)');

  // Cleanup — B never became a socket, only A needs closing.
  resultA.ws.close(1000, 'Test complete');
  // Release the shared lease before the next test starts (see TS-005 note).
  await waitForFreeLease();

  console.log('  ✅ TS-007: Different instance + healthy old → 409 Conflict (genuine conflict correctly rejected)');
});

// ─── TS-012: 409 Decision Matrix ─────────────────────────────────────
// This needs the DO to itself. Every row opens a connection with a fresh
// instanceId, and the 409 guard correctly refuses those while a real
// extension holds a healthy slot — so with a browser connected even the
// FIRST connection is refused and the matrix cannot start. Verified against
// production: extension connected, a fresh instanceId gets HTTP 409 from
// /bridge; extension idle, the same request gets 101.
//
// That is the guard working, not a defect. detectBusyLease() below states
// the precondition, so reuse it rather than adding a second env var for
// the same condition.
test('TS-012: 409 Decision Matrix — 5 rows verified', { skip }, async (t) => {
  await detectBusyLease();
  if (leaseTaken) {
    t.skip('connection lease held by live extension (' + leaseDetail + ') — detach it, or set BRIDGE_PHASE5_ASSUME_FREE_LEASE=1');
    return;
  }
  await detectBusyLease();
  if (leaseTaken) {
    t.skip('connection lease held by live extension (' + leaseDetail + ') — detach it, or set BRIDGE_PHASE5_ASSUME_FREE_LEASE=1');
    return;
  }
  const results = [];

  // ── Row 1: same_instance_id, same_token, old_connection_stale → ACCEPT ──
  {
    const instanceId = uuidv4();
    // Connect and then let it go idle (>45s would be ideal, but we'll
    // use the /bridge/reset endpoint to force-evict the old connection,
    // simulating "stale" state)
    const r1 = await connectBridgeWithStatus(instanceId);
    assert.equal(r1.code, 101, `Row 1: first connection should succeed, got ${r1.code}`);
    sendSessionReady(r1.ws, { instanceId });
    await new Promise(r => setTimeout(r, 300));

    // Close first connection (simulating stale/old disconnect)
    r1.ws.close(1000, 'Simulate stale old connection');
    await new Promise(r => setTimeout(r, 500));

    // Reconnect with same instanceId → should be accepted
    const r2 = await connectBridgeWithStatus(instanceId);
    const accepted = r2.code === 101;
    results.push({ row: 1, scenario: 'same_id, stale', expected: 'ACCEPT', actual: r2.code === 101 ? 'ACCEPT' : `HTTP ${r2.code}`, pass: accepted });
    assert.ok(accepted, `Row 1: same instanceId, stale old → should be ACCEPT, got ${r2.code}`);
    if (r2.ws) r2.ws.close(1000, 'Test complete');
  }

  // ── Row 2: same_instance_id, same_token, old_connection_healthy → ACCEPT ──
  {
    const instanceId = uuidv4();
    const r1 = await connectBridgeWithStatus(instanceId);
    assert.equal(r1.code, 101, `Row 2: first connection should succeed, got ${r1.code}`);
    sendSessionReady(r1.ws, { instanceId });
    await new Promise(r => setTimeout(r, 300));

    // Reconnect with SAME instanceId (old one still healthy)
    const r2 = await connectBridgeWithStatus(instanceId);
    const accepted = r2.code === 101;
    results.push({ row: 2, scenario: 'same_id, healthy', expected: 'ACCEPT', actual: r2.code === 101 ? 'ACCEPT' : `HTTP ${r2.code}`, pass: accepted });
    assert.ok(accepted, `Row 2: same instanceId, healthy old → should be ACCEPT, got ${r2.code}`);

    // Close both connections
    r1.ws.close(1000, 'Test complete');
    if (r2.ws) r2.ws.close(1000, 'Test complete');
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Row 3: different_instance_id, same_token, old_connection_stale → ACCEPT ──
  {
    const idA = uuidv4();
    const idB = uuidv4();

    // Connect A, send SESSION_READY, then close (simulating stale)
    const rA = await connectBridgeWithStatus(idA);
    assert.equal(rA.code, 101, `Row 3: connection A should succeed, got ${rA.code}`);
    sendSessionReady(rA.ws, { instanceId: idA });
    await new Promise(r => setTimeout(r, 300));
    rA.ws.close(1000, 'Simulate stale old connection');
    await new Promise(r => setTimeout(r, 500));

    // Connect B (different instance, old was stale) → should be accepted
    const rB = await connectBridgeWithStatus(idB);
    const accepted = rB.code === 101;
    results.push({ row: 3, scenario: 'diff_id, stale', expected: 'ACCEPT', actual: rB.code === 101 ? 'ACCEPT' : `HTTP ${rB.code}`, pass: accepted });
    assert.ok(accepted, `Row 3: different instanceId, stale old → should be ACCEPT, got ${rB.code}`);
    if (rB.ws) rB.ws.close(1000, 'Test complete');
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Row 4: different_instance_id, same_token, old_connection_healthy → 409 ──
  {
    const idA = uuidv4();
    const idB = uuidv4();

    // Connect A and keep it healthy
    const rA = await connectBridgeWithStatus(idA);
    assert.equal(rA.code, 101, `Row 4: connection A should succeed, got ${rA.code}`);
    sendSessionReady(rA.ws, { instanceId: idA });
    await new Promise(r => setTimeout(r, 300));

    // Connect B (different instance, old is healthy) → should get 409.
    // Probed over HTTP: a WebSocket client cannot observe a 409 handshake
    // response, it only ever sees close 1006 (see probeUpgradeStatus).
    const rB = await probeUpgradeStatus(idB);
    const rejected = rB.status === 409;
    results.push({ row: 4, scenario: 'diff_id, healthy', expected: '409', actual: rB.status === 409 ? '409' : `HTTP ${rB.status}`, pass: rejected });
    assert.ok(rejected, `Row 4: different instanceId, healthy old → should be 409, got ${rB.status} (${rB.body.slice(0, 60)})`);

    // Verify A is still alive
    assert.equal(rA.ws.readyState, 1, 'Row 4: original connection A should still be OPEN');

    rA.ws.close(1000, 'Test complete');
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Row 5: different_token → 401 ──
  {
    // Probed over HTTP for the same reason as row 4: a WebSocket client sees
    // only close 1006 for a rejected handshake, never the 401 status.
    const url = `${WORKER_URL}/bridge?token=${encodeURIComponent('invalid-token-' + uuidv4())}&instanceId=${uuidv4()}`;
    const res = await fetch(url);
    const body = await res.text();
    const rejected = res.status === 401;
    results.push({ row: 5, scenario: 'diff_token', expected: '401', actual: res.status === 401 ? '401' : `HTTP ${res.status}`, pass: rejected });
    assert.ok(rejected, `Row 5: different token → should be 401, got ${res.status} (${body.slice(0, 60)})`);
  }

  // ── Print matrix summary ──
  console.log('\n  📊 TS-012: 409 Decision Matrix Results:');
  console.table(results.map(r => ({
    Row: r.row,
    Scenario: r.scenario,
    Expected: r.expected,
    Actual: r.actual,
    Pass: r.pass ? '✅' : '❌',
  })));

  console.log('  ✅ TS-012: All 5 matrix rows passed — 409 logic verified');
});
