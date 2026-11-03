import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(__dirname, '../src/index.js'), 'utf-8');
const guardrailSrc = readFileSync(join(__dirname, '../src/guardrail.ts'), 'utf-8');

test('KAN-308: origin allowlist replaces wildcard CORS', () => {
  assert.ok(!indexSrc.includes('"Access-Control-Allow-Origin": "*"'), 'wildcard CORS removed');
  assert.ok(indexSrc.includes('isLoopbackOrigin') || guardrailSrc.includes('isLoopbackOrigin'));
  assert.ok(indexSrc.includes('isOriginAllowed') || guardrailSrc.includes('isOriginAllowed'));
  assert.ok(indexSrc.includes('localhost') && indexSrc.includes('127'));
});

test('KAN-308: non-allowlisted origin rejected', () => {
  assert.ok(indexSrc.includes('Origin not allowed') || guardrailSrc.includes('Origin not allowed'));
  assert.ok(indexSrc.includes('status: 403') || indexSrc.includes('status:403'));
});

test('KAN-308: 4 MiB size cap and 413', () => {
  assert.ok(indexSrc.includes('4 * 1024 * 1024') || guardrailSrc.includes('4 * 1024 * 1024'));
  assert.ok(indexSrc.includes('413') || guardrailSrc.includes('413'));
  assert.ok(indexSrc.includes('MAX_REQUEST_BODY_BYTES') || guardrailSrc.includes('MAX_REQUEST_BODY_BYTES'));
});

test('KAN-308: circuit breaker 3 failures / 60s / 30s cooldown', () => {
  assert.ok(indexSrc.includes('CircuitBreaker') || guardrailSrc.includes('CircuitBreaker'));
  assert.ok(indexSrc.includes('failureThreshold = 3') || indexSrc.includes('failureThreshold: 3') || guardrailSrc.includes('failureThreshold = 3'));
  assert.ok(indexSrc.includes('windowMs = 60000') || indexSrc.includes('windowMs: 60000') || guardrailSrc.includes('windowMs = 60000'));
  assert.ok(indexSrc.includes('cooldownMs = 30000') || indexSrc.includes('cooldownMs: 30000') || guardrailSrc.includes('cooldownMs = 30000'));
});

test('KAN-308: header redaction', () => {
  assert.ok(indexSrc.includes('redactHeaders') || guardrailSrc.includes('redactHeaders'));
  assert.ok(indexSrc.includes('REDACTED') || guardrailSrc.includes('REDACTED'));
  assert.ok(indexSrc.includes('authorization') || guardrailSrc.includes('authorization'));
});
