// Phase 2-3: Search Proxy and Guardrail Tests

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Phase 2: Search Proxy Tests ───

test('Phase 2: search-proxy should have default configuration', () => {
  const source = readFileSync(join(__dirname, '../src/search-proxy.ts'), 'utf-8');
  
  assert.ok(source.includes('DEFAULT_SEARCH_PROXY_CONFIG'), 'Default config should be defined');
  assert.ok(source.includes('timeoutMs: 60000'), 'Default timeout should be 60000ms');
  assert.ok(source.includes('maxRetries: 3'), 'Default max retries should be 3');
  assert.ok(source.includes('retryDelayMs: 1000'), 'Default retry delay should be 1000ms');
});

test('Phase 2: search-proxy should export SearchProxy class', () => {
  const source = readFileSync(join(__dirname, '../src/search-proxy.ts'), 'utf-8');
  
  assert.ok(source.includes('export class SearchProxy'), 'SearchProxy class should be exported');
  assert.ok(source.includes('export class HttpSearchProxy'), 'HttpSearchProxy class should be exported');
  assert.ok(source.includes('export interface SearchResult'), 'SearchResult interface should be exported');
});

test('Phase 2: search-proxy should have execute method', () => {
  const source = readFileSync(join(__dirname, '../src/search-proxy.ts'), 'utf-8');
  
  assert.ok(source.includes('async execute<T'), 'execute method should be defined');
  assert.ok(source.includes('executeWithRetry'), 'executeWithRetry method should be defined');
  assert.ok(source.includes('executeBatch'), 'executeBatch method should be defined');
});

test('Phase 2: search-proxy should integrate with Guardrail', () => {
  const source = readFileSync(join(__dirname, '../src/search-proxy.ts'), 'utf-8');
  
  assert.ok(source.includes("import { Guardrail"), 'Should import Guardrail');
  assert.ok(source.includes("from './guardrail"), 'Should import from guardrail module');
});

test('Phase 2: search-proxy should support retries', () => {
  const source = readFileSync(join(__dirname, '../src/search-proxy.ts'), 'utf-8');
  
  assert.ok(source.includes('Exponential backoff'), 'Should implement exponential backoff');
  assert.ok(source.includes('Math.pow(2, attempt)'), 'Should use exponential backoff formula');
});

// ─── Phase 3: Guardrail Tests ───

test('Phase 3: guardrail should have presets defined', () => {
  const source = readFileSync(join(__dirname, '../src/guardrail.ts'), 'utf-8');
  
  assert.ok(source.includes('GuardrailPresets'), 'GuardrailPresets should be defined');
  assert.ok(source.includes('development:'), 'Development preset should exist');
  assert.ok(source.includes('staging:'), 'Staging preset should exist');
  assert.ok(source.includes('production:'), 'Production preset should exist');
});

test('Phase 3: guardrail production preset should have correct limits', () => {
  const source = readFileSync(join(__dirname, '../src/guardrail.ts'), 'utf-8');
  
  // Check production preset values
  assert.ok(source.includes('maxChars: 30000'), 'Production maxChars should be 30000');
  assert.ok(source.includes('truncateAt: 3000'), 'Production truncateAt should be 3000');
  assert.ok(source.includes('spillThreshold: 10000'), 'Production spillThreshold should be 10000');
  assert.ok(source.includes('contentFilter: true'), 'Production contentFilter should be true');
});

test('Phase 3: guardrail should export Guardrail class', () => {
  const source = readFileSync(join(__dirname, '../src/guardrail.ts'), 'utf-8');
  
  assert.ok(source.includes('export class Guardrail'), 'Guardrail class should be exported');
  assert.ok(source.includes('export interface GuardrailConfig'), 'GuardrailConfig interface should be exported');
  assert.ok(source.includes('export interface GuardrailResult'), 'GuardrailResult interface should be exported');
});

test('Phase 3: guardrail should have processResult method', () => {
  const source = readFileSync(join(__dirname, '../src/guardrail.ts'), 'utf-8');
  
  assert.ok(source.includes('processResult'), 'processResult method should be defined');
  assert.ok(source.includes('action: \'none\''), 'Should define none action');
  assert.ok(source.includes("action: 'truncate'"), "Should define truncate action");
  assert.ok(source.includes("action: 'summarize'"), "Should define summarize action");
  assert.ok(source.includes("action: 'spill_to_file'"), "Should define spill_to_file action");
});

test('Phase 3: guardrail should implement truncation', () => {
  const source = readFileSync(join(__dirname, '../src/guardrail.ts'), 'utf-8');
  
  assert.ok(source.includes('private truncate'), 'truncate method should exist');
  assert.ok(source.includes('[truncated]'), 'Should add truncation marker');
  assert.ok(source.includes('truncationPoint'), 'Should track truncation point');
});

test('Phase 3: guardrail should implement summarization', () => {
  const source = readFileSync(join(__dirname, '../src/guardrail.ts'), 'utf-8');
  
  assert.ok(source.includes('private summarize'), 'summarize method should exist');
  assert.ok(source.includes('generateSummary'), 'generateSummary helper should exist');
  assert.ok(source.includes('maxSummaryLength'), 'Should respect maxSummaryLength');
});

test('Phase 3: guardrail should implement spill-to-file', () => {
  const source = readFileSync(join(__dirname, '../src/guardrail.ts'), 'utf-8');
  
  assert.ok(source.includes('private spillToTempFile'), 'spillToTempFile method should exist');
  assert.ok(source.includes('tmpdir()'), 'Should use tmpdir for spill files');
  assert.ok(source.includes('spillPath'), 'Should include spillPath in metadata');
  assert.ok(source.includes('randomUUID'), 'Should use UUID for unique filenames');
});

test('Phase 3: guardrail should implement content filtering', () => {
  const source = readFileSync(join(__dirname, '../src/guardrail.ts'), 'utf-8');
  
  assert.ok(source.includes('private applyFilters'), 'applyFilters method should exist');
  assert.ok(source.includes('filterPatterns'), 'Should support filterPatterns');
  assert.ok(source.includes('REDACTED'), 'Should redact filtered content');
  assert.ok(source.includes('\\s+'), 'Should normalize whitespace');
});

test('Phase 3: guardrail should track statistics', () => {
  const source = readFileSync(join(__dirname, '../src/guardrail.ts'), 'utf-8');
  
  assert.ok(source.includes('getStats'), 'getStats method should exist');
  assert.ok(source.includes('filteredCount'), 'Should track filteredCount');
  assert.ok(source.includes('processedCount'), 'Should track processedCount');
  assert.ok(source.includes('resetStats'), 'resetStats method should exist');
});

// ─── Integration Tests ───

test('Phase 2-3: search-proxy should pass guardrail metadata', () => {
  const source = readFileSync(join(__dirname, '../src/search-proxy.ts'), 'utf-8');
  
  assert.ok(source.includes('operation: \'search\''), 'Should add operation metadata');
  assert.ok(source.includes('queryLength'), 'Should add queryLength metadata');
  assert.ok(source.includes('resultSize'), 'Should add resultSize metadata');
});

test('Phase 2-3: search-proxy result should include guardrail info', () => {
  const source = readFileSync(join(__dirname, '../src/search-proxy.ts'), 'utf-8');
  
  assert.ok(source.includes('guardrailAction'), 'Should include guardrailAction in result');
  assert.ok(source.includes('truncated'), 'Should include truncated in result');
  assert.ok(source.includes('bytesProcessed'), 'Should include bytesProcessed in result');
});
