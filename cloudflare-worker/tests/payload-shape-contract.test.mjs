// payload-shape-contract.test.mjs
//
// Pinned contracts for Gemini StreamGenerate wire payload shape (KAN-236).
// Enforces the 20-field topological invariant, the [0][3] notebook-binding branch,
// and the structural divergences from the worker builder across all 7 captures.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Injected = require('../../extension-cloudflare/injected.js');
const { STRING_CLASS } = Injected;

import {
  normalizeNode,
  flattenStructure,
  describeWorkerBuilder,
  diffShapes,
  analyzeCaptures
} from '../../scripts/analyze-payload-shape.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE_PATH = path.join(ROOT, 'cloudflare-worker/tests/fixtures/streamgenerate-captures.json');
const SAMPLE_PATH = path.join(ROOT, 'docs/payload-samples/2026-09-29-streamgenerate.json');

test('every sanitized capture in the repository exhibits the 20-field topological invariant', () => {
  const f1 = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const f2 = JSON.parse(fs.readFileSync(SAMPLE_PATH, 'utf8'));

  const allStructures = [];

  for (const [k, cap] of Object.entries(f1.captures || {})) {
    assert.equal(cap.structure?.length, 20,
      `fixture capture ${k} (${cap.case}) must have exactly 20 top-level fields`);
    allStructures.push({ id: `fixture-${k}`, structure: cap.structure });
  }

  for (const sample of f2.samples || []) {
    const inner = sample.structure?.structure;
    assert.equal(inner?.length, 20,
      `sample capture ${sample.label} must have exactly 20 top-level fields`);
    allStructures.push({ id: `sample-${sample.label}`, structure: inner });
  }

  assert.equal(allStructures.length, 7, 'all 7 sanitized captures in the repo must be verified');

  for (const { id, structure } of allStructures) {
    // [1]: locale array
    const field1 = normalizeNode(structure[1]);
    assert.ok(Array.isArray(field1), `${id}: field [1] must be a locale array`);

    // [2]: strictly null in all 7 browser captures (contradicts worker builder)
    const field2 = normalizeNode(structure[2]);
    assert.equal(field2, null, `${id}: field [2] must be null`);

    // [3]: context block string (varying length > 1000)
    const field3 = normalizeNode(structure[3]);
    const contextLen = typeof field3 === 'string'
      ? field3.length
      : field3?.length;
    assert.ok(typeof contextLen === 'number' && contextLen > 1000,
      `${id}: field [3] must be context block string with length > 1000`);

    // [4]: conversationId (32 hex characters)
    const field4 = normalizeNode(structure[4]);
    const convLen = typeof field4 === 'string'
      ? field4.length
      : field4?.length;
    assert.equal(convLen, 32, `${id}: field [4] must be 32-character conversationId`);

    // Invariant null fields across all 7 captures: [5], [8], [9], [12], [13], [14], [15], [16]
    for (const nullIdx of [5, 8, 9, 12, 13, 14, 15, 16]) {
      assert.equal(normalizeNode(structure[nullIdx]), null,
        `${id}: field [${nullIdx}] must be null`);
    }

    // Number / numeric array indices: [6], [7], [10], [11], [17], [18]
    assert.ok(structure[6] !== null && structure[6] !== undefined, `${id}: field [6] must exist`);
    assert.ok(structure[7] !== null && structure[7] !== undefined, `${id}: field [7] must exist`);
    assert.ok(structure[10] !== null && structure[10] !== undefined, `${id}: field [10] must exist`);
    assert.ok(structure[11] !== null && structure[11] !== undefined, `${id}: field [11] must exist`);
    assert.ok(structure[17] !== null && structure[17] !== undefined, `${id}: field [17] must exist`);
    assert.ok(structure[18] !== null && structure[18] !== undefined, `${id}: field [18] must exist`);
  }
});

test('chip-attached captures carry the 88-char token at [0][3], while chip-absent captures have null', () => {
  const f1 = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const f2 = JSON.parse(fs.readFileSync(SAMPLE_PATH, 'utf8'));

  // Chip-present captures: 10-02 (cases 1, 2, 3) and 09-29 (samples A & B)
  const chipPresentCaptures = [
    f1.captures['1'].structure,
    f1.captures['2'].structure,
    f1.captures['3'].structure,
    f2.samples[0].structure.structure,
    f2.samples[1].structure.structure
  ];

  for (let i = 0; i < chipPresentCaptures.length; i++) {
    const s = chipPresentCaptures[i];
    assert.ok(s[0] && Array.isArray(s[0]), `chip present capture ${i}: [0] must be an array`);
    const chipBranch = s[0][3];
    assert.ok(chipBranch && Array.isArray(chipBranch),
      `chip present capture ${i}: [0][3] must be present as a nested array`);

    const tokenEntry = chipBranch[0]?.[2];
    assert.ok(tokenEntry, `chip present capture ${i}: [0][3][0][2] must exist`);

    const tokenLen = tokenEntry.length !== undefined ? tokenEntry.length : tokenEntry;
    assert.equal(tokenLen, 88, `chip present capture ${i}: token length must be 88`);

    if (tokenEntry.fingerprint) {
      assert.equal(tokenEntry.fingerprint, 'cff9779e',
        `chip present capture ${i}: fingerprint of the Horo token must be cff9779e`);
    }
  }

  // Chip-absent captures: 10-01 (case 0) and 10-02 (case 4)
  const chipAbsentCaptures = [
    f1.captures['0'].structure,
    f1.captures['4'].structure
  ];

  for (let i = 0; i < chipAbsentCaptures.length; i++) {
    const s = chipAbsentCaptures[i];
    const field0 = normalizeNode(s[0]);
    const chipBranch = Array.isArray(field0) ? field0[3] : null;
    assert.equal(chipBranch ?? null, null,
      `chip absent capture ${i}: [0][3] must be null`);
  }
});

test('diffShapes catches pinned divergences against the worker builder', () => {
  const f1 = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const chipPresent = f1.captures['2'].structure; // 10-02 Present 2b
  const flat = flattenStructure(chipPresent);
  const diff = diffShapes(flat);

  assert.equal(diff.observedTopFields, 20);
  assert.equal(diff.builderTopFields, 12);

  const reasons = diff.divergences.map(d => d.reason);
  assert.ok(reasons.includes('type_contradiction'),
    'must detect index [2] type contradiction (null vs state array)');
  assert.ok(reasons.includes('missing_context_block'),
    'must detect index [3] context block absence in builder');
  assert.ok(reasons.includes('missing_conversation_id'),
    'must detect index [4] conversationId absence in builder');
  assert.ok(reasons.includes('missing_chip_attachment'),
    'must detect index [0][3] chip attachment token absence in builder');
  assert.ok(reasons.includes('field_count_mismatch'),
    'must detect top-level field count mismatch (20 vs 12)');
});

test('guardrail G1.2.1: every string node across all captures satisfies classification hygiene', () => {
  const f1 = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const validClasses = new Set(Object.values(STRING_CLASS));

  for (const [k, cap] of Object.entries(f1.captures || {})) {
    const flat = flattenStructure(cap.structure);
    for (const node of flat) {
      if (node.cls !== null && node.cls !== undefined) {
        assert.ok(validClasses.has(node.cls),
          `capture ${k} node at ${node.path} has invalid string class '${node.cls}'`);
      }
      assert.equal(node.value, undefined,
        `capture ${k} node at ${node.path} leaked raw string value into fixture`);
    }
  }
});
