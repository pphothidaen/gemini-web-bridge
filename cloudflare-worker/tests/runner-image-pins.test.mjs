// Guard: no job may use a floating runner label.
//
// (KAN-228)
//
// All 13 `runs-on:` declarations used `ubuntu-latest`. Upstream rolls
// that label to Ubuntu 26.04 starting Oct 19 2026 and completes Nov
// 19 ([actions/runner-images#14748]). A floating label means the image
// moves underneath the repo with no commit and no diff - which is the
// whole reason the exposure here is worth naming.
//
//   Ubuntu 24.04          Ubuntu 26.04
//   24.04.5 LTS           26.04.1 LTS
//   kernel 6.17.0-1022    kernel 7.0.0-1012
//   systemd 255.4         systemd 259.5
//
// Docker, Minikube, the AWS/Azure/GCloud CLIs, Rust, Firefox and Java
// are identical across both, so the exposure is concentrated in the
// kernel and init system rather than the toolchain. For this repo the
// parts that could actually move are gitleaks-action (a binary
// distribution, sensitive to base-image library changes) and the CD
// deploy path, because cd.yml is the single deploy authority.
//
// KAN-228's acceptance criterion names this test directly, and the
// decision it encodes is upstream's own recommendation: migrate to
// ubuntu-26.04 deliberately, while ubuntu-latest is still 24.04, so a
// regression is attributable to the image rather than to the label
// moving under you.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

import {
  REPO_ROOT,
  TARGET_RUNNER,
  collectRunnerImages,
  scanRunnerImages,
} from './helpers/action-pins.mjs';

const WATCHDOG = fs.readFileSync(
  join(REPO_ROOT, '.github/workflows/cd-watchdog.yml'),
  'utf8'
);

test('every job runs on an explicit image label (KAN-228)', () => {
  const report = scanRunnerImages();

  assert.ok(
    report.checked > 0,
    'the scan found no runs-on: declarations. A scanner that reads zero ' +
      'jobs reports success while checking nothing.'
  );

  assert.deepEqual(
    report.floating,
    [],
    `floating runner labels:\n  ${report.floating.join('\n  ')}`
  );
  assert.deepEqual(
    report.unpinned,
    [],
    `jobs not pinned to an explicit image:\n  ${report.unpinned.join('\n  ')}`
  );
  assert.equal(report.ok, true);
});

test('no runner declaration uses a -latest label (KAN-228)', () => {
  // Asserted directly against the collected values rather than only
  // through the scanner, so the invariant is readable without trusting
  // the scanner's own classification.
  const floating = collectRunnerImages().filter(({ value }) => /-latest\b/.test(value));

  assert.deepEqual(
    floating.map((f) => `${f.value} at ${f.file}:${f.line}`),
    [],
    'ubuntu-latest rolls to 26.04 from Oct 19 2026; a floating label ' +
      'changes the image with no commit and no diff to review'
  );
});

test('every job is on the same runner major (KAN-228)', () => {
  const report = scanRunnerImages();

  assert.equal(
    report.mixed,
    false,
    `jobs span more than one runner major (${report.majors.join(', ')}). ` +
      'A half-migrated runner set is the exact state in which a failure ' +
      'is unattributable to an image, which is the reason this ticket exists.'
  );
  assert.deepEqual(report.majors, ['26']);
});

test('all 13 declarations are accounted for (KAN-228)', () => {
  // Counts the declarations rather than trusting that a regex found
  // the right ones. If a future workflow is added and lands on a
  // floating label, `floating` catches it; this catches the case where
  // the scanner stops finding jobs at all.
  const all = collectRunnerImages();
  assert.equal(
    all.length,
    13,
    `expected 13 runs-on: declarations, found ${all.length}. ci.yml has 8, ` +
      'cd.yml 2, cd-watchdog.yml 1, keepalive-probe.yml 1, token-rotation.yml 1. ' +
      'A count change means a job was added or removed - update this test ' +
      'in the same commit.'
  );
});

test('every declaration is an explicit ubuntu-<major>.<minor> label (KAN-228)', () => {
  const bad = collectRunnerImages()
    .filter(({ value }) => !/^ubuntu-\d+\.\d+$/.test(value))
    .map((f) => `${f.value} at ${f.file}:${f.line}`);

  assert.deepEqual(
    bad,
    [],
    'every job must name its image outright. A templated label is ' +
      'unverifiable without the matrix that resolves it, and no workflow ' +
      'here declares one.'
  );
});

test('the target image is a concrete GA label, not a placeholder (KAN-228)', () => {
  // ubuntu-26.04 went GA on Sep 17 2026 (runner-images#14747) and is
  // selectable today. Asserting the constant is a real label keeps this
  // test from passing against a value that was never pinned.
  assert.match(TARGET_RUNNER, /^ubuntu-\d+\.\d+$/);
  assert.equal(
    TARGET_RUNNER,
    'ubuntu-26.04',
    'KAN-228 decision: migrate deliberately rather than ride the label. ' +
      'If this changes, it is a decision to record, not a detail to edit.'
  );
});

test('the watchdog still parses timestamps with GNU date (KAN-228)', () => {
  // cd-watchdog.yml uses `date -u -d`, a GNU coreutils extension that
  // does not exist on BSD/macOS. Checked because the runner image is
  // changing underneath it: this keeps visible the shell assumption the
  // watchdog's stall detection depends on, so a future image change that
  // alters coreutils shows up here rather than as a watchdog that silently
  // reports zero stalls.
  assert.match(
    WATCHDOG,
    /date -u -d/,
    'the watchdog parses timestamps with GNU date; keep that assumption visible'
  );
});