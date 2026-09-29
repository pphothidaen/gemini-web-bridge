// ============================================================
// DOM signal contract
//
// Every claim this extension makes about Gemini's live DOM is
// declared here with the observation that justifies it. A signal
// without a `measured` block fails checkDomSignals(), and so fails
// the build.
//
// Why this exists. Twice in one session a selector that read like it
// meant one thing turned out to mean another, and both times the
// tests passed:
//
//   KAN-192  the manifest said 4.7.10 and a test asserted the
//            manifest string, while the JavaScript beside it was older
//   KAN-197  has-thoughts and processing-state-visible read like
//   /198     "currently processing" and are permanent. Keying on them
//            made isGenerating() true forever: handleCollectAnswer
//            burned its 120s budget and every call failed with
//            collect_answer_timeout on finished answers.
//
// Both were tests written to agree with whatever the code did. A test
// can be built to assert whatever is true, which is why a green suite
// was not evidence. The remedy is not more care; it is a requirement
// that a signal and its evidence arrive together.
//
// `observed` records whether a signal was actually SEEN on this build.
// That is a different statement from "wrong": the spinner and
// stop-button checks match nothing here, but cost nothing and may
// match on another build, so they stay - recorded honestly.
// ============================================================

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, resolved from this file so any test can use the helpers. */
export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const SPINNER = 'div.loading-content-spinner-container, mat-progress-spinner.mat-mdc-progress-spinner';
const STOP_BTN = 'button[aria-label*="หยุดการสร้าง"], button[aria-label*="Stop generating"]';
const LOTTIE = 'clipPath[id^="__lottie_element"], svg[clip-path*="__lottie_element"]';

/**
 * One entry per DOM signal the extension reads.
 *
 * `states` is what the contract CLAIMS; the fixture is what was
 * OBSERVED. A null state means "not observed, no behaviour claimed" -
 * the honest record for a check that matches nothing on this build.
 */
export const DOM_SIGNALS = [
  {
    id: 'response.generating',
    file: 'extension-cloudflare/native-recovery.js',
    selector: '[aria-busy="true"]',
    scope: 'newest-response',
    states: { generating: true, settled: false },
    observed: true,
    measured: {
      date: '2026-09-29',
      fixture: 'generating-signal.json',
      method:
        'One whole generation sampled every couple of seconds. aria-busy ' +
        'present at response heights 1242px and 3508px; absent once the ' +
        'footer gained class "complete" at 4311px. The three signals below ' +
        'were queried at the same moments and matched nothing at any of them.'
    }
  },
  {
    // The signal that decides grounded vs not. Load-bearing: if this
    // selector is wrong, every grounded answer is reported ungrounded and
    // the tool refuses to answer at all.
    //
    // Evidence is a count, not a capture. chips=7 and chips=8 were logged
    // on grounded runs on 2026-09-29, so the selector demonstrably matches.
    // A capture of what the element looks like is T3 in KAN-200 and is the
    // one thing here that cannot be transcribed from existing evidence.
    id: 'grounding.source_chip',
    file: 'extension-cloudflare/notebook-attach.js',
    // A custom element whose TAG NAME is `source-inline-chip` - not a class.
    selector: 'source-inline-chip',
    scope: 'newest-response',
    states: { generating: false, settled: true },
    observed: true,
    evidenceKind: 'captured',
    measured: {
      date: '2026-09-29',
      fixture: 'grounding-chips.json',
      method:
        'T3 in KAN-200, the measurement that could not be transcribed. ' +
        'Captured from a live notebook-grounded answer on a two-response ' +
        'conversation: the newest model-response (926px) rendered 3 chips, ' +
        'the earlier one (4348px) rendered none. readGroundingEvidence ' +
        'reported chips=3, matching the DOM exactly.'
    }
  },
  {
    // The second grounding signal, and it has never fired once. Every
    // recorded grounded run logged chips=7 cites=0 or chips=8 cites=0.
    //
    // It is declared here so the record says plainly that the grounding
    // check rests on ONE signal, not two. A branch that cannot be taken is
    // not a second opinion; it is decoration that made the check look
    // stronger than it was.
    id: 'grounding.cite_marker',
    file: 'extension-cloudflare/notebook-attach.js',
    selector: 'text:/\\[cite:\\s*\\d+\\]/',
    scope: 'text-content',
    states: { generating: null, settled: null },
    observed: false,
    unobservedBecause:
      'Never matched. cites=0 on the T3 capture and on every grounded run ' +
      'recorded 2026-09-29 while chips was 3-8, so the chip selector is ' +
      'carrying the whole decision alone. Kept in the code because the ' +
      'worker error path and the health report both carry the field, and a ' +
      'renderer that does emit inline markers would otherwise be invisible.',
    measured: {
      date: '2026-09-29',
      fixture: 'grounding-chips.json',
      method: 'Regex over the response innerText of the T3 capture; zero matches. Recorded as absent rather than dressed up as a checked signal.'
    }
  },
  {
    id: 'response.spinner',
    file: 'extension-cloudflare/native-recovery.js',
    selector: SPINNER,
    scope: 'newest-response',
    states: { generating: null, settled: null },
    observed: false,
    unobservedBecause:
      'Queried mid-generation and after settling on 2026-09-29; zero ' +
      'elements both times. The document-wide fallback still exists and is ' +
      'guarded against the chat-history loader in the sidenav.',
    measured: { date: '2026-09-29', fixture: 'generating-signal.json', method: 'Absent in both captured states.' }
  },
  {
    id: 'response.stop_button',
    file: 'extension-cloudflare/native-recovery.js',
    selector: STOP_BTN,
    scope: 'newest-response',
    states: { generating: null, settled: null },
    observed: false,
    unobservedBecause:
      'Queried mid-generation and after settling on 2026-09-29; zero ' +
      'elements both times. Localized labels, so a build with different ' +
      'wording would also miss.',
    measured: { date: '2026-09-29', fixture: 'generating-signal.json', method: 'Absent in both captured states.' }
  },
  {
    id: 'document.lottie',
    file: 'extension-cloudflare/native-recovery.js',
    selector: LOTTIE,
    scope: 'document',
    states: { generating: null, settled: null },
    observed: false,
    unobservedBecause:
      'Queried mid-generation and after settling on 2026-09-29; zero ' +
      'elements both times. Document-scoped: not inside the response.',
    measured: { date: '2026-09-29', fixture: 'generating-signal.json', method: 'Absent in both captured states.' }
  }
];

export const SIGNAL_IDS = DOM_SIGNALS.map((s) => s.id);

/**
 * Selector matching for exactly the forms the extension queries.
 *
 * Not a CSS engine, and deliberately strict: an unrecognised selector
 * throws rather than resolving to null. In the KAN-198 work a stub's
 * matcher silently failed to match
 * `div.loading-content-spinner-container`, and two tests failed for the
 * wrong reason - which is how a matcher starts hiding problems.
 *
 * Supported: *, tag, .class, tag.class, #id, [attr="v"], [attr*="v"],
 * [attr^="v"], [attr$="v"], and comma-separated lists of those.
 */
export function matchesSelector(node, selector) {
  if (typeof selector !== 'string' || selector.trim() === '') {
    throw new TypeError(`unsupported selector: ${JSON.stringify(selector)}`);
  }
  const parts = selector.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new TypeError(`unsupported selector: ${JSON.stringify(selector)}`);
  return parts.some((one) => matchesOne(node, one));
}

function matchesOne(node, selector) {
  if (selector === '*') return true;
  const attr = selector.match(/\[([\w-]+)([*^$~]?)=("?)([^"\]]*)\3\]/);
  let base = selector;
  if (attr) {
    base = selector.replace(attr[0], '').trim();
    const name = attr[1];
    const op = attr[2];
    const value = attr[4];
    const actual = node.attrs ? node.attrs[name] : undefined;
    if (actual === undefined) return false;
    const str = String(actual);
    if (op === '*' && !str.includes(value)) return false;
    else if (op === '^' && !str.startsWith(value)) return false;
    else if (op === '$' && !str.endsWith(value)) return false;
    else if (op === '' && str !== value) return false;
  }
  if (base === '') return true;
  if (base.startsWith('#')) return (node.attrs && node.attrs.id) === base.slice(1);
  if (base.startsWith('.')) return String(node.class || '').includes(base.slice(1));
  const bits = base.split('.');
  const tag = bits[0];
  const classes = bits.slice(1);
  if (tag && node.tag && node.tag !== tag) return false;
  return classes.every((c) => String(node.class || '').includes(c));
}

/**
 * Build a document stub from a captured fixture.
 *
 * Routing tests through a capture is the point: the DOM they run against
 * came from a browser, not from the implementation, so a test cannot
 * quietly drift into asserting the code's own behaviour.
 *
 * `scope: "newest-response"` wraps the nodes in a single model-response
 * so the extension's own newest-response scoping is exercised rather
 * than bypassed.
 */
export function buildStubFromFixture(fixture, state) {
  const captured = fixture && fixture.states && fixture.states[state];
  if (!captured) {
    const have = Object.keys((fixture && fixture.states) || {}).join(', ') || 'none';
    throw new Error(`fixture has no state '${state}' (has: ${have})`);
  }
  const nodes = (captured.nodes || []).map((n) => ({
    tag: n.tag,
    class: n.class,
    attrs: Object.assign({}, n.attrs || {})
  }));
  const allNodes = nodes;

  const container = (children) => ({
    _nodes: children,
    querySelector(sel) {
      return children.find((n) => safeMatch(n, sel)) || null;
    },
    querySelectorAll(sel) {
      if (sel === '*') return children;
      return children.filter((n) => safeMatch(n, sel));
    },
    closest() { return null; }
  });

  if (fixture.scope === 'newest-response') {
    // A capture may hold several responses. That is the only way to tell a
    // scoped check from a document-wide one: with a single response both
    // find the same node and agree, so `scope` would be declared but never
    // verified.
    const responses = (captured.responses || [{ nodes: captured.nodes || [] }])
      .map((r) => container((r.nodes || []).map((n) => ({
        tag: n.tag, class: n.class, attrs: Object.assign({}, n.attrs || {})
      }))));
    const doc = container(allNodes);
    doc.querySelectorAll = (sel) => (sel === 'model-response' ? responses : []);
    return doc;
  }
  return container(nodes);
}

function safeMatch(node, selector) {
  try {
    return matchesSelector(node, selector);
  } catch {
    return false;
  }
}

function lastResponseOf(stub) {
  const all = stub.querySelectorAll('model-response');
  return all.length ? all[all.length - 1] : null;
}

function defaultReadFixture(name, repo) {
  const path = join(repo, 'cloudflare-worker', 'tests', 'fixtures', name);
  if (!existsSync(path)) throw new Error('fixture file not found');
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Validate every declared signal against its evidence.
 *
 * Three failure classes rather than one boolean, so the message says
 * which mistake was made:
 *
 *   unmeasured  - declared with no measured block
 *   unbacked    - names a fixture that is missing or unparseable
 *   mismatched  - the fixture does not produce the declared states
 */
export function checkDomSignals(options = {}) {
  const opts = options || {};
  const signals = opts.signals || DOM_SIGNALS;
  const repo = opts.repo || REPO_ROOT;
  const readFixture = opts.readFixture || defaultReadFixture;

  const report = { ok: true, unmeasured: [], unbacked: [], mismatched: [], checked: 0 };

  for (const signal of signals) {
    const m = signal.measured;
    if (!m || !m.date || !m.fixture) {
      report.unmeasured.push(signal.id);
      report.ok = false;
      continue;
    }

    let fixture;
    try {
      fixture = readFixture(m.fixture, repo);
    } catch (err) {
      report.unbacked.push(`${signal.id} (${m.fixture}: ${err.message})`);
      report.ok = false;
      continue;
    }

    const states = signal.states || {};
    const claimed = Object.keys(states).filter((k) => states[k] !== null && states[k] !== undefined);
    if (!claimed.length) {
      report.checked += 1;              // declared, unobserved, nothing claimed
      continue;
    }

    for (const state of claimed) {
      const want = states[state];
      let got;
      try {
        const stub = buildStubFromFixture(fixture, state);
        const target = signal.scope === 'newest-response' ? lastResponseOf(stub) : stub;
        got = Boolean(target && target.querySelector(signal.selector));
      } catch (err) {
        report.mismatched.push(`${signal.id}.${state} (threw: ${err.message})`);
        report.ok = false;
        continue;
      }
      if (got !== want) {
        report.mismatched.push(
          `${signal.id}.${state} (fixture ${got ? 'matches' : 'does not match'}, contract claims ${want})`
        );
        report.ok = false;
      }
    }
    report.checked += 1;
  }

  return report;
}

/**
 * Write a capture in the one format the corpus uses.
 *
 * Exists so the fixture shape has a single writer and cannot drift into
 * six formats. Not called by any test - it is the tool that makes
 * taking the next capture a mechanical step.
 */
export function recordCapture(fixturePath, signalId, states, options = {}) {
  const fixture = {
    signal: signalId,
    captured: options.captured || new Date().toISOString().slice(0, 10),
    note: options.note || 'structural attributes only; no text content, no tokens',
    scope: options.scope || 'newest-response',
    states
  };
  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  return fixture;
}
