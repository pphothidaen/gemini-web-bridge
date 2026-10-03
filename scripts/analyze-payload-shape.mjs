#!/usr/bin/env node
/**
 * scripts/analyze-payload-shape.mjs
 *
 * Analyzes and flattens StreamGenerate payload captures, compares observed
 * browser wire structures against the worker builder, and validates the 20-field
 * topological invariant.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

/**
 * Normalizes a field node that may be in indexed object format ({ index, kind, items }).
 */
export function normalizeNode(node) {
  if (node === null || node === undefined) return null;
  if (typeof node === 'object' && !Array.isArray(node) && node.index !== undefined && node.kind) {
    if (node.kind === 'null') return null;
    if (node.kind === 'array') return node.items || [];
    return { kind: node.kind, length: node.length, cls: node.cls, fingerprint: node.fingerprint };
  }
  return node;
}

/**
 * Recursively flattens a nested payload structure into an array of path entries.
 * Handles bare values, arrays, and sanitized descriptor objects ({kind/type, length, cls}).
 */
export function flattenStructure(rawNode, curPath = '') {
  const result = [];
  const node = normalizeNode(rawNode);

  if (node === null || node === undefined) {
    result.push({ path: curPath || 'root', kind: 'null', length: 0 });
    return result;
  }

  // Sanitized descriptor node
  if (typeof node === 'object' && !Array.isArray(node)) {
    const kind = node.kind || node.type || (node.items ? 'array' : 'object');
    if (node.items && Array.isArray(node.items)) {
      node.items.forEach((item, idx) => {
        result.push(...flattenStructure(item, `${curPath}[${idx}]`));
      });
      return result;
    }
    result.push({
      path: curPath || 'root',
      kind,
      length: node.length !== undefined ? node.length : null,
      cls: node.cls || null,
      fingerprint: node.fingerprint || null
    });
    return result;
  }

  if (Array.isArray(node)) {
    if (node.length === 0) {
      result.push({ path: curPath || 'root', kind: 'array', length: 0 });
      return result;
    }
    node.forEach((item, idx) => {
      result.push(...flattenStructure(item, `${curPath}[${idx}]`));
    });
    return result;
  }

  result.push({
    path: curPath || 'root',
    kind: typeof node,
    length: typeof node === 'string' ? node.length : null,
    value: typeof node === 'number' || typeof node === 'boolean' ? node : undefined
  });

  return result;
}

/**
 * Returns the structural schema of the worker builder emitted by cloudflare-worker/src/index.js.
 */
export function describeWorkerBuilder() {
  const builderReqArray = [
    [{ kind: 'string', cls: 'opaque' }, 0, null, null, null, null, 0], // [0]
    [{ kind: 'string', length: 2, cls: 'locale' }],                      // [1]
    ['convId', 'respId', 'choiceId', null, null, []],                   // [2]
    null, null, null, [1], 0, [], [], 1, 0                              // [3..11]
  ];
  return flattenStructure(builderReqArray);
}

/**
 * Compares an observed structure (inner array) against the worker builder structure.
 * Returns load-bearing divergences at pinned indices.
 */
export function diffShapes(observedStructure, builderStructure = describeWorkerBuilder()) {
  const observedMap = new Map();
  const builderMap = new Map();

  for (const entry of observedStructure) {
    observedMap.set(entry.path, entry);
  }
  for (const entry of builderStructure) {
    builderMap.set(entry.path, entry);
  }

  const divergences = [];

  // Pinned index [2]: Contradiction between null and 6-element array
  const obs2 = observedMap.get('[2]');
  const bldHas2 = Array.from(builderMap.keys()).some(k => k.startsWith('[2]'));
  const bld2Kind = builderMap.get('[2]')?.kind || (bldHas2 ? 'array' : 'null');
  if (obs2 && obs2.kind !== bld2Kind) {
    divergences.push({
      index: 2,
      path: '[2]',
      reason: 'type_contradiction',
      observed: obs2.kind,
      builder: bld2Kind,
      description: 'Browser sends null; worker builder emits state array [convId, respId, choiceId, ...]'
    });
  }

  // Pinned index [3]: Context block absent in builder
  const obs3 = observedMap.get('[3]');
  const bld3 = builderMap.get('[3]');
  if (obs3 && (!bld3 || bld3.kind === 'null')) {
    divergences.push({
      index: 3,
      path: '[3]',
      reason: 'missing_context_block',
      observed: obs3.kind,
      builder: bld3 ? bld3.kind : 'absent',
      description: 'Browser sends dynamic context block string; worker builder emits null'
    });
  }

  // Pinned index [4]: ConversationId hex absent in builder
  const obs4 = observedMap.get('[4]');
  const bld4 = builderMap.get('[4]');
  if (obs4 && (!bld4 || bld4.kind === 'null')) {
    divergences.push({
      index: 4,
      path: '[4]',
      reason: 'missing_conversation_id',
      observed: obs4.kind,
      builder: bld4 ? bld4.kind : 'absent',
      description: 'Browser sends 32-hex conversationId string; worker builder emits null'
    });
  }

  // Pinned index [0][3]: Notebook chip branch
  const obsChip = observedMap.get('[0][3][0][2]');
  const bldChip = builderMap.get('[0][3]');
  if (obsChip && (!bldChip || bldChip.kind === 'null')) {
    divergences.push({
      index: '0.3',
      path: '[0][3]',
      reason: 'missing_chip_attachment',
      observed: 'present (88-char token)',
      builder: bldChip ? bldChip.kind : 'absent',
      description: 'Browser sends 88-char token branch for notebook chip; worker builder emits null'
    });
  }

  // Top-level field count divergence (20 in browser vs 12 in builder)
  const observedTopFields = new Set(
    Array.from(observedMap.keys())
      .map(p => p.match(/^\[([0-9]+)\]/)?.[1])
      .filter(Boolean)
  ).size;

  const builderTopFields = new Set(
    Array.from(builderMap.keys())
      .map(p => p.match(/^\[([0-9]+)\]/)?.[1])
      .filter(Boolean)
  ).size;

  if (observedTopFields !== builderTopFields) {
    divergences.push({
      index: 'count',
      path: 'length',
      reason: 'field_count_mismatch',
      observed: observedTopFields,
      builder: builderTopFields,
      description: `Browser sends ${observedTopFields} fields; worker builder emits ${builderTopFields} fields`
    });
  }

  return {
    observedTopFields,
    builderTopFields,
    divergences
  };
}

/**
 * Loads captures from fixtures and generates an analysis report.
 */
export function analyzeCaptures() {
  const fixturePath = path.join(ROOT, 'cloudflare-worker/tests/fixtures/streamgenerate-captures.json');
  const samplePath = path.join(ROOT, 'docs/payload-samples/2026-09-29-streamgenerate.json');

  const report = {
    fixtureCapturesCount: 0,
    sampleCapturesCount: 0,
    results: []
  };

  if (fs.existsSync(fixturePath)) {
    const f1 = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    for (const [key, cap] of Object.entries(f1.captures || {})) {
      const inner = cap.structure;
      const flat = flattenStructure(inner);
      const diff = diffShapes(flat);
      report.results.push({
        source: 'streamgenerate-captures.json',
        key,
        case: cap.case,
        capturedAt: cap.capturedAt,
        fieldCount: inner.length,
        hasChipBranch: flat.some(e => e.path.startsWith('[0][3]') && e.kind !== 'null'),
        diff
      });
      report.fixtureCapturesCount++;
    }
  }

  if (fs.existsSync(samplePath)) {
    const f2 = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
    for (const sample of f2.samples || []) {
      const inner = sample.structure?.structure || [];
      const flat = flattenStructure(inner);
      const diff = diffShapes(flat);
      report.results.push({
        source: '2026-09-29-streamgenerate.json',
        label: sample.label,
        grounding_outcome: sample.grounding_outcome,
        fieldCount: inner.length,
        hasChipBranch: flat.some(e => e.path.startsWith('[0][3]') && e.kind !== 'null'),
        diff
      });
      report.sampleCapturesCount++;
    }
  }

  return report;
}

// CLI Execution
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = analyzeCaptures();
  console.log(`Analyzed ${report.fixtureCapturesCount + report.sampleCapturesCount} captures total.`);
  for (const r of report.results) {
    const name = r.case || r.label || r.key;
    console.log(`- [${r.source}] ${name}: fields=${r.fieldCount}, chipBranch=${r.hasChipBranch}, divergences=${r.diff.divergences.length}`);
  }
}
