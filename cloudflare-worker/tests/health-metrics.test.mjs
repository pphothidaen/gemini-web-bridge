// Regression tests for the /health counters.
//
// `healthState` is a derived getter that builds a fresh object on every read,
// so every historical `this.healthState.consecutiveErrors++` /
// `= lastError` write mutated a throwaway copy. Production /health therefore
// reported `consecutive_errors: 0, last_error: null` forever and the
// `check_bridge_health` "degraded" threshold could never fire.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as catalog from '../src/model-catalog.js';
import * as emulator from '../src/tool-emulator.ts';
import * as pdfLib from 'pdf-lib';

const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const context = {
  ...catalog,
  ...emulator,
  ...pdfLib,
  DurableObject: class {},
  crypto,
  Request,
  Response,
  URL,
  TextEncoder,
  TextDecoder,
  TransformStream,
  ReadableStream,
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => {}
};

const { GeminiBridgeDO } = vm.runInNewContext(
  source.replace(/import[\s\S]*?from "[^"\n]+";/g, '')
    .replaceAll('export class ', 'class ')
    .replace('export default {', 'const entry = {') +
  '\n;({GeminiBridgeDO})',
  context
);

const createBridge = () => {
  const b = new GeminiBridgeDO({}, { CLIENT_API_TOKEN: 'k', BRIDGE_AUTH_TOKEN: 'b' });
  b.currentTokens = { sessionReady: true };
  return b;
};

test('health metrics: recordHealthError accumulates and survives repeated reads', () => {
  const b = createBridge();

  b.recordHealthError('boom 1');
  b.recordHealthError('boom 2');

  assert.equal(b.healthState.consecutiveErrors, 2);
  assert.equal(b.healthState.lastError, 'boom 2');
  // A fresh read must not reset the counter (that was the original bug).
  assert.equal(b.healthState.consecutiveErrors, 2);

  b.recordHealthSuccess();
  assert.equal(b.healthState.consecutiveErrors, 0);
  assert.equal(b.healthState.lastError, null);
  assert.ok(b.healthState.lastSuccessfulGeneration > 0);
});

test('health metrics: /health surfaces the real error counters and a degraded status', async () => {
  const b = createBridge();
  b.recordHealthError('Execution error in extension');
  b.recordHealthError('Execution error in extension');
  b.recordHealthError('Execution error in extension');

  const res = await b.fetch(new Request('https://test/health'));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.health_metrics.consecutive_errors, 3);
  assert.equal(body.health_metrics.last_error, 'Execution error in extension');

  const check = await b.fetch(new Request('https://test/mcp', {
    method: 'POST',
    headers: { Authorization: 'Bearer k', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_bridge_health', arguments: {} } })
  }));
  const checkBody = await check.json();
  const report = JSON.parse(checkBody.result.content[0].text);
  assert.equal(report.metrics.consecutive_errors, 3);
  assert.equal(report.metrics.last_error, 'Execution error in extension');
  // 3+ consecutive errors must actually flip the status now that the counter
  // persists ("degraded" once a provider is available, "critical" when none).
  assert.ok(['degraded', 'critical'].includes(report.status), 'unexpected status: ' + report.status);
});
