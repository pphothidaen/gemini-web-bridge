// ============================================================
// Mock "live" tests — the 5 previously-skipped integration cases,
// replayed entirely in-process against the real DO source (VM sandbox,
// same technique as bridge-handshake.test.mjs): no server, no network,
// with injectable artificial delay for realistic-timing scenarios.
//
// Mirrors the skipped live tests:
//   - "WebSocket upgrade succeeds with valid subprotocol"
//   - TS-005: same instanceId reconnect accepted (not 409)
//   - TS-007: different instanceId + healthy old connection -> 409
//   - TS-012: 409 decision matrix
//   - "POST /v1/chat/completions sends message and receives response"
//
// Run: node --test tests/mock-live.test.mjs
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMockWorker, connectFakeExtension } from './helpers/mock-worker.mjs';
const uuid = () => randomUUID();


test('MOCK: WebSocket upgrade succeeds against in-process worker', async (t) => {
  const worker = createMockWorker();
  const id = uuid();

  const res = await worker.upgradeWebSocket(
    '/bridge?token=' + encodeURIComponent(worker.BRIDGE_SECRET) + '&client=background_sw&instanceId=' + id
  );
  assert.equal(res.status, 101, 'upgrade must return 101');
  assert.ok(res.server, 'DO must record a server-side socket');
  assert.equal(worker.bridge.activeConnections.size, 1);
  assert.ok(worker.bridge.activeConnections.has(id));
});

test('MOCK: upgrade rejects a wrong bridge token', async (t) => {
  const worker = createMockWorker();

  const res = await worker.fetch('/bridge?token=wrong-token&client=background_sw&instanceId=' + uuid(), {
    headers: { 'x-bridge-token': 'wrong-token', Upgrade: 'websocket' },
  });
  assert.equal(res.status, 401, 'wrong token must not upgrade');
});

test('MOCK TS-005: same instanceId reconnect is accepted (not 409)', async (t) => {
  const worker = createMockWorker();
  const tok = encodeURIComponent(worker.BRIDGE_SECRET);
  const id = uuid();

  const first = await worker.upgradeWebSocket(`/bridge?token=${tok}&client=background_sw&instanceId=${id}`);
  assert.equal(first.status, 101);
  first.server.close(1000, 'reconnect');

  const second = await worker.upgradeWebSocket(`/bridge?token=${tok}&client=background_sw&instanceId=${id}`);
  assert.equal(second.status, 101, 'same instanceId reconnect must be accepted');
  assert.equal(worker.bridge.activeConnections.get(id).epoch, 2, 'epoch must increment on reconnect');
});

test('MOCK TS-007/TS-012: 409 decision matrix', async (t) => {
  const worker = createMockWorker();
  const tok = encodeURIComponent(worker.BRIDGE_SECRET);

  // Row 1: no active connection -> accepted.
  const a = await worker.upgradeWebSocket(`/bridge?token=${tok}&client=background_sw&instanceId=${uuid()}`);
  assert.equal(a.status, 101, 'first instance must be accepted');

  // Row 2: different instanceId while A healthy -> 409 (no hijack).
  const b = await worker.upgradeWebSocket(`/bridge?token=${tok}&client=background_sw&instanceId=${uuid()}`);
  assert.equal(b.status, 409, 'different healthy instance must be rejected with 409');

  // Row 3: A closes -> lease free -> B accepted.
  a.server.close(1000, 'mock closed');
  const b2 = await worker.upgradeWebSocket(`/bridge?token=${tok}&client=background_sw&instanceId=${uuid()}`);
  assert.equal(b2.status, 101, 'after lease release the other instance must be accepted');
});

test('MOCK: POST /v1/chat/completions round-trip through fake extension', async (t) => {
  const worker = createMockWorker();

  const ext = await connectFakeExtension(worker, {
    onExecute: () => ({ text: 'Hello from the mock extension', delayMs: 0 }),
  });

  const res = await worker.fetch('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + worker.CLIENT_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200, 'chat completion must succeed with a connected fake extension');
  const body = await res.json();
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices?.[0]?.message?.content, 'Hello from the mock extension');
  ext.close();
});

test('MOCK: injected delay simulates latency (timing stays deterministic)', async (t) => {
  const worker = createMockWorker();
  worker.setDelay(150); // artificial latency on every HTTP round-trip

  const started = Date.now();
  const res = await worker.fetch('/health');
  const elapsed = Date.now() - started;
  assert.equal(res.status, 200);
  assert.ok(elapsed >= 300, `round-trip must take >= 2x150ms delay, took ${elapsed}ms`);
  assert.ok(elapsed < 5000, 'delay must be deterministic, not a timeout');
});

test('MOCK: fake extension reply delay is honoured (realistic pacing)', async (t) => {
  const worker = createMockWorker();

  const REPLY_DELAY = 200;
  const ext = await connectFakeExtension(worker, {
    onExecute: () => ({ text: 'slow reply', delayMs: REPLY_DELAY }),
  });

  const started = Date.now();
  const res = await worker.fetch('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + worker.CLIENT_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const elapsed = Date.now() - started;
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices?.[0]?.message?.content, 'slow reply');
  assert.ok(elapsed >= REPLY_DELAY, `reply delay must be honoured, took ${elapsed}ms`);
  ext.close();
});
