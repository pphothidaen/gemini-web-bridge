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
 *     env WORKER_URL=https://gemini-web-bridge.pansakorn-pho.workers.dev \
 *     node --test tests/phase5-instance-id.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const WORKER_URL = process.env.WORKER_URL || 'https://gemini-web-bridge.pansakorn-pho.workers.dev';
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || '';

const skip = BRIDGE_AUTH_TOKEN
  ? false
  : 'BRIDGE_AUTH_TOKEN not set — Phase 5 live tests not exercised';

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Connect a WebSocket to /bridge with the given instanceId and token.
 * Returns { ws, promise } where promise resolves on open or rejects on error/close.
 */
function connectBridge(instanceId) {
  const wsUrl = WORKER_URL.replace('https://', 'wss://');
  const params = new URLSearchParams({
    token: BRIDGE_AUTH_TOKEN,
    instanceId,
  });
  const url = `${wsUrl}/bridge?${params.toString()}`;

  const ws = new WebSocket(url, ['gemini-bridge-v3']);

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
function connectBridgeWithStatus(instanceId) {
  const wsUrl = WORKER_URL.replace('https://', 'wss://');
  const params = new URLSearchParams({
    token: BRIDGE_AUTH_TOKEN,
    instanceId,
  });
  const url = `${wsUrl}/bridge?${params.toString()}`;

  return new Promise((resolve) => {
    const ws = new WebSocket(url, ['gemini-bridge-v3']);
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
      if (!resolved) {
      resolved = true;
      clearTimeout(timeout);
      // For a failed handshake, event.code will be the HTTP status code
      // (e.g. 409, 401). For a normal close after open, it's 1000.
      resolve({ status: 'rejected', code: event.code, ws });
      }
    };
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
test('TS-005: Same instanceId reconnect is accepted (not 409)', { skip }, async () => {
  // Step 1: Connect with instanceId=A
  const instanceId = uuidv4();
  const result1 = await connectBridgeWithStatus(instanceId);
  assert.equal(result1.code, 101, `First connection should succeed (101), got ${result1.code}`);

  // Send SESSION_READY to establish session
  sendSessionReady(result1.ws, { instanceId, tokens: { bridge: BRIDGE_AUTH_TOKEN } });

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

  console.log('  ✅ TS-005: Same-instance reconnect accepted (101), not 409');
});

// ─── TS-007: Different Instance + Healthy Old → 409 ──────────────────
test('TS-007: Different instanceId + healthy old connection → 409', { skip }, async () => {
  // Step 1: Connect with instanceId=A and keep it healthy
  const instanceIdA = uuidv4();
  const resultA = await connectBridgeWithStatus(instanceIdA);
  assert.equal(resultA.code, 101, `First connection should succeed, got ${resultA.code}`);

  // Send SESSION_READY to establish session
  sendSessionReady(resultA.ws, { instanceId: instanceIdA, tokens: { bridge: BRIDGE_AUTH_TOKEN } });
  await new Promise(r => setTimeout(r, 500));

  // Step 2: Try to connect with DIFFERENT instanceId=B (same token)
  const instanceIdB = uuidv4();
  const resultB = await connectBridgeWithStatus(instanceIdB);

  // Expected: 409 Conflict (genuine conflict — different device, healthy old connection)
  assert.equal(resultB.code, 409,
    `Different instanceId with healthy old conn should get 409, got ${resultB.code}`);

  // Step 3: Verify original connection A is still healthy and active
  // (send a message and see if we get a response)
  assert.equal(resultA.ws.readyState, 1, 'Original connection A should still be OPEN (readyState=1)');

  // Cleanup
  resultA.ws.close(1000, 'Test complete');
  if (resultB.ws) resultB.ws.close(1000, 'Test complete');

  console.log('  ✅ TS-007: Different instance + healthy old → 409 Conflict (genuine conflict correctly rejected)');
});

// ─── TS-012: 409 Decision Matrix ─────────────────────────────────────
test('TS-012: 409 Decision Matrix — 5 rows verified', { skip }, async () => {
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

    // Connect B (different instance, old is healthy) → should get 409
    const rB = await connectBridgeWithStatus(idB);
    const rejected = rB.code === 409;
    results.push({ row: 4, scenario: 'diff_id, healthy', expected: '409', actual: rB.code === 409 ? '409' : `HTTP ${rB.code}`, pass: rejected });
    assert.ok(rejected, `Row 4: different instanceId, healthy old → should be 409, got ${rB.code}`);

    // Verify A is still alive
    assert.equal(rA.ws.readyState, 1, 'Row 4: original connection A should still be OPEN');

    rA.ws.close(1000, 'Test complete');
    if (rB.ws) rB.ws.close(1000, 'Test complete');
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Row 5: different_token → 401 ──
  {
    const wsUrl = WORKER_URL.replace('https://', 'wss://');
    const params = new URLSearchParams({
      token: 'invalid-token-' + uuidv4(),
      instanceId: uuidv4(),
    });
    const url = `${wsUrl}/bridge?${params.toString()}`;

    const result = await new Promise((resolve) => {
      const ws = new WebSocket(url, ['gemini-bridge-v3']);
      const timeout = setTimeout(() => {
        ws.close();
        resolve({ code: 'timeout', status: 'timeout' });
      }, 5000);

      ws.onopen = () => {
        clearTimeout(timeout);
        resolve({ code: 101, status: 'connected' });
      };
      ws.onerror = () => {};
      ws.onclose = (event) => {
        clearTimeout(timeout);
        resolve({ code: event.code, status: 'rejected' });
      };
    });

    const rejected = result.code === 401;
    results.push({ row: 5, scenario: 'diff_token', expected: '401', actual: result.code === 401 ? '401' : `HTTP ${result.code}`, pass: rejected });
    assert.ok(rejected, `Row 5: different token → should be 401, got ${result.code}`);
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
