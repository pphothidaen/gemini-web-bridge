// ============================================================
// KAN-182: DO telemetry ring buffer + /debug/telemetry endpoint.
//
// `wrangler tail` does not surface Durable Object console output on
// this worker (verified 2026-10-04: a top-level Worker diag log
// appears in tail, a DO diag log does not, though every request
// routes through the DO), and `observability` stays disabled per
// KAN-236. So the ring buffer served by /debug/telemetry is the only
// telemetry channel that can ever be read back. These tests pin the
// three properties it must keep:
//
//   1. the endpoint is authenticated exactly like /debug/payload-capture
//      (same generic gate, 401 without credentials),
//   2. the buffer is a bounded ring — the 51st entry evicts the oldest,
//   3. the executeThroughExtension success path actually records.
//
// Run: node --test tests/kan182-telemetry-endpoint.test.mjs
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMockWorker, connectFakeExtension } from './helpers/mock-worker.mjs';

const WORKER_SOURCE = fs.readFileSync(
  new URL('../src/index.js', import.meta.url).pathname,
  'utf8'
);

test('KAN-182: /debug/telemetry requires the same auth as /debug/payload-capture', async () => {
  const worker = createMockWorker();

  const tel = await worker.fetch('/debug/telemetry');
  const cap = await worker.fetch('/debug/payload-capture');
  assert.equal(tel.status, 401, 'telemetry without credentials must be 401');
  assert.equal(cap.status, 401, 'payload-capture without credentials must be 401 (control)');
  assert.equal(tel.status, cap.status,
    'the two debug endpoints must share one auth decision');

  const telBody = await tel.json();
  assert.equal(telBody.error?.code, 'invalid_api_key',
    'the 401 must come from the generic auth gate, not an ad-hoc check');

  const ok = await worker.fetch('/debug/telemetry', {
    headers: { 'Authorization': 'Bearer ' + worker.CLIENT_API_KEY },
  });
  assert.equal(ok.status, 200, 'the same Bearer key must unlock telemetry');
  const body = await ok.json();
  assert.equal(body.ok, true);
  assert.equal(body.count, 0);
  assert.deepEqual(body.entries, []);
});

test('KAN-182: /debug/telemetry is not in publicPaths (source contract)', () => {
  const pub = WORKER_SOURCE.match(/const publicPaths = \[[^\]]*\];/)[0];
  assert.ok(!pub.includes('telemetry'),
    '/debug/telemetry must never become public — it is the payload-capture class of endpoint');
});

test('KAN-182: recordTelemetry caps the buffer at 50, evicting the oldest', async () => {
  const worker = createMockWorker();
  const { bridge } = worker;

  for (let i = 1; i <= 51; i++) {
    bridge.recordTelemetry({ kind: 'test', seq: i, outcome: 'ok' });
  }

  assert.equal(bridge.telemetryBuffer.length, 50, 'the buffer must hold exactly the cap');
  assert.equal(bridge.telemetryBuffer[0].seq, 2, 'entry 1 must have been evicted (oldest)');
  assert.equal(bridge.telemetryBuffer[49].seq, 51, 'the newest entry must be last');
  assert.equal(typeof bridge.telemetryBuffer[0].ts, 'number',
    'recordTelemetry stamps every entry with ts');
});

test('KAN-182: GET returns entries newest-first; DELETE clears the buffer', async () => {
  const worker = createMockWorker();
  const { bridge } = worker;
  const auth = { headers: { 'Authorization': 'Bearer ' + worker.CLIENT_API_KEY } };

  bridge.recordTelemetry({ kind: 'test', seq: 1, outcome: 'ok' });
  bridge.recordTelemetry({ kind: 'test', seq: 2, outcome: 'ok' });

  const get = await worker.fetch('/debug/telemetry', auth);
  assert.equal(get.status, 200);
  const body = await get.json();
  assert.equal(body.count, 2);
  assert.equal(body.entries[0].seq, 2, 'newest first');
  assert.equal(body.entries[1].seq, 1);

  const del = await worker.fetch('/debug/telemetry', { method: 'DELETE', ...auth });
  assert.equal(del.status, 200);
  const delBody = await del.json();
  assert.equal(delBody.ok, true);
  assert.equal(bridge.telemetryBuffer.length, 0, 'DELETE must empty the buffer');

  const after = await (await worker.fetch('/debug/telemetry', auth)).json();
  assert.equal(after.count, 0);
});

test('KAN-182: a successful executeThroughExtension records kind=outcome telemetry', async () => {
  const worker = createMockWorker();

  const ext = await connectFakeExtension(worker, {
    onExecute: () => ({ text: 'telemetry probe reply' }),
  });

  const res = await worker.fetch('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + worker.CLIENT_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  ext.close();

  const entry = worker.bridge.telemetryBuffer.find((e) => e.kind === 'executeThroughExtension');
  assert.ok(entry, 'the success path must have recorded an executeThroughExtension entry');
  assert.equal(entry.outcome, 'ok');
  assert.equal(entry.messages, 1);
  assert.equal(typeof entry.durationMs, 'number');
  assert.ok(entry.durationMs >= 0);
  // Metadata only — the record must never carry prompt or response content.
  const dumped = JSON.stringify(entry);
  assert.ok(!dumped.includes('telemetry probe reply'), 'no response content in telemetry');
  assert.ok(!dumped.includes('hi'), 'no prompt content in telemetry');
});

test('KAN-182: a failed executeThroughExtension records an error outcome', async () => {
  const worker = createMockWorker();

  // No extension connected -> the first failWith path fires. Called directly,
  // because /v1/chat/completions short-circuits to 503 before it ever reaches
  // executeThroughExtension when the extension is down.
  await assert.rejects(
    () => worker.bridge.executeThroughExtension([{ role: 'user', content: 'hi' }]),
    /Extension not connected/
  );

  const entry = worker.bridge.telemetryBuffer.find((e) => e.kind === 'executeThroughExtension');
  assert.ok(entry, 'the failure path must have recorded an executeThroughExtension entry');
  assert.equal(entry.outcome, 'error');
  assert.ok(entry.error && typeof entry.error === 'string', 'error message must be present');
});

test('KAN-182: source contract — success exit and failWith both record, cap is 50', () => {
  // The success path records kind/outcome/duration. This is a source-regex
  // assertion so a future refactor that moves the success exit cannot silently
  // drop the record the way the first typed path once dropped success writing.
  assert.match(WORKER_SOURCE,
    /this\.recordTelemetry\(\{ kind: "executeThroughExtension", durationMs: Date\.now\(\) - startTime, messages: messages\.length, outcome: "ok" \}\)/,
    'the executeThroughExtension success exit must record telemetry');
  assert.match(WORKER_SOURCE,
    /const failWith = \(err\) => \{[\s\S]{0,400}?this\.recordTelemetry\(\{ kind: "executeThroughExtension", durationMs: Date\.now\(\) - startTime, messages: messages\.length, outcome: "error", error: err\?\.message \|\| "unknown" \}\)/,
    'every failWith exit must record an error entry');
  assert.match(WORKER_SOURCE,
    /this\.recordTelemetry\(\{ kind: "callGcpGemini", durationMs: Date\.now\(\) - startTime, messages: messages\.length, outcome: "ok" \}\)/,
    'callGcpGemini success must record too');
  assert.match(WORKER_SOURCE, /const TELEMETRY_BUFFER_MAX = 50;/,
    'the cap must be a named constant');
});

test('KAN-182: source contract — both early extension-disconnect fail-fast sites record preflight telemetry', () => {
  // The chat-completions handler and the horo_consult fail-closed branch both
  // return/throw "extension not connected" BEFORE executeThroughExtension or
  // callGcpGemini ever runs, so without a preflight record /debug/telemetry
  // stays empty exactly when the caller most needs to see the disconnect
  // (verified live 2026-10-04). Source-regex assertions pin both sites.
  const chatSite = WORKER_SOURCE.match(
    /this\.recordTelemetry\(\{ kind: "preflight", outcome: "error", error: "extension disconnected", messages: body\.messages\.length \}\);[\s\S]{0,800}?code: "extension_disconnected"/
  );
  assert.ok(chatSite,
    'the chat-completions 503 must be preceded by a preflight recordTelemetry call');

  const horoSite = WORKER_SOURCE.match(
    /this\.recordTelemetry\(\{ kind: "preflight", outcome: "error", error: "extension disconnected" \}\);[\s\S]{0,300}?Chrome Extension is not connected/
  );
  assert.ok(horoSite,
    'the horo_consult fail-closed error must be preceded by a preflight recordTelemetry call');

  // No preflight record may carry prompt or response content — the chat site
  // carries only a message COUNT and the horo sites carry no payload field.
  // Three sites since the KAN-204 stage pipeline: chat-completions,
  // horo_consult single call, and the horo_consult stage pipeline, which
  // fails closed the same way.
  const preflightCalls = WORKER_SOURCE.match(/this\.recordTelemetry\(\{ kind: "preflight"[^)]*\}\)/g) || [];
  assert.equal(preflightCalls.length, 3,
    'exactly three preflight record sites (chat-completions + horo_consult + horo pipeline)');
  for (const call of preflightCalls) {
    assert.ok(!call.includes('content'), 'preflight telemetry must not log content');
  }
});

test('KAN-182: DELETE /debug/telemetry without credentials must be 401', async () => {
  const worker = createMockWorker();
  const del = await worker.fetch('/debug/telemetry', { method: 'DELETE' });
  assert.equal(del.status, 401);
});

test('KAN-182: recordTelemetry sanitizes error messages: redacts key= and truncates to 200 chars', () => {
  const worker = createMockWorker();
  const { bridge } = worker;

  const longErrWithKey = 'GCP Gemini API error (400): Request failed at https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=AIzaSySecretApiKey1234567890 with error details: ' + 'x'.repeat(250);
  bridge.recordTelemetry({ kind: 'test', outcome: 'error', error: longErrWithKey });

  assert.equal(bridge.telemetryBuffer.length, 1);
  const recorded = bridge.telemetryBuffer[0];
  assert.ok(!recorded.error.includes('AIzaSySecretApiKey1234567890'), 'API key must be redacted');
  assert.ok(recorded.error.includes('key=[REDACTED]'), 'key query param must be replaced with [REDACTED]');
  assert.ok(recorded.error.length <= 200, `error length must be <= 200, got ${recorded.error.length}`);
});
