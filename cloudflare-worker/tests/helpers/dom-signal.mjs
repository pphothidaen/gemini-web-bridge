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

// KAN-231. Measured on a live tab while the extension was running; see
// fixtures/prompt-typing.json. These are the selectors prompt-typing.js uses
// to decide whether a request is ever submitted, and until 2026-10-01 none of
// them had a capture behind them.
const THINKING_DOTS = 'thinking-dots-animation';
const PENDING_REQUEST = 'pending-request';
const PENDING_RESPONSE = 'pending-response';
const RICH_TEXTAREA = 'input-area-v2 rich-textarea';
const EDITOR = 'input-area-v2 .ql-editor[contenteditable="true"]';
const SEND_BUTTON = 'input-area-v2 button:has(mat-icon[data-mat-icon-name="arrow_upward"])';
const SEND_BUTTON_FALLBACK = "input-area-v2 button.send-button, input-area-v2 [data-test-id='send-button']";

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
    // KAN-231. The signal that covers the phase aria-busy misses.
    //
    // Measured 2026-10-01: while Gemini is thinking, aria-busy is 0 and no
    // model-response exists yet — the answer is still inside a
    // `pending-request` container as a `pending-response` sibling. So the
    // shipped `response.generating` signal is silent for the whole thinking
    // phase, and its declared `newest-response` scope has nothing new to
    // inspect. The gap between "prompt submitted" and "aria-busy fires" is a
    // window in which the extension concludes nothing is happening.
    //
    // This is KAN-197/198's shape one level up: a proxy read as the state
    // itself. aria-busy proxies "streaming"; the question is "generating".
    id: 'generation.thinking_dots',
    file: 'extension-cloudflare/native-recovery.js',
    selector: THINKING_DOTS,
    scope: 'document',
    states: { thinking: true, streaming: false, settled: false },
    observed: true,
    evidenceKind: 'captured',
    notYetWiredIntoCode: true,
    notYetWiredBecause:
      'Declaring it is not the same as changing isGenerating(), and the two ' +
      'deserve separate decisions. The code change alters extension ' +
      'behaviour and needs a version bump plus a reload of the unpacked ' +
      'build; the declaration is only a statement of what was measured. ' +
      'Wiring it is tracked separately so this record cannot be mistaken ' +
      'for a fix.',
    measured: {
      date: '2026-10-01',
      fixture: 'prompt-typing.json',
      method:
        '23 samples at 1.5s across one real generation, submitted by ' +
        'clicking the actual send control on a focused tab. T1_thinking: ' +
        'thinking-dots-animation=1, aria-busy=0, model-response still 3. ' +
        'T2_streaming: aria-busy=1, model-response=4. T3_settled: ' +
        'aria-busy=0. Only changed values were recorded.'
    }
  },
  {
    // The container the answer is born in. Recorded because it is what makes
    // the scope question decidable: during thinking, the pending response is
    // NOT inside any model-response, so a newest-response-scoped query cannot
    // see the generation in progress no matter how good its selector is.
    id: 'generation.pending_request',
    file: 'extension-cloudflare/native-recovery.js',
    selector: PENDING_REQUEST,
    scope: 'document',
    states: { thinking: true, streaming: false, settled: false },
    observed: true,
    evidenceKind: 'captured',
    measured: {
      date: '2026-10-01',
      fixture: 'prompt-typing.json',
      method:
        'Ancestry traced from the thinking indicator. pending-request holds ' +
        'exactly three element children in this order: user-query, ' +
        'thinking-dots-animation, pending-response. It sits under ' +
        'infinite-scroller.chat-history, NOT under any model-response.'
    }
  },
  {
    id: 'generation.pending_response',
    file: 'extension-cloudflare/native-recovery.js',
    selector: PENDING_RESPONSE,
    scope: 'document',
    states: { thinking: true, streaming: false, settled: false },
    observed: true,
    evidenceKind: 'captured',
    measured: {
      date: '2026-10-01',
      fixture: 'prompt-typing.json',
      method:
        'Present as a sibling of thinking-dots-animation during the thinking ' +
        'phase with zero model-response to match. Disappears when the ' +
        'answer promotes to model-response.'
    }
  },
  {
    // The editor. Recorded because sendButton only exists once this has
    // content, which is the entire reason a send_button_not_found failure is
    // ambiguous between "the selector is stale" and "the text never landed".
    id: 'prompt.editor',
    file: 'extension-cloudflare/prompt-typing.js',
    selector: EDITOR,
    scope: 'document',
    states: { empty: true, filled: true },
    observed: true,
    evidenceKind: 'captured',
    measured: {
      date: '2026-10-01',
      fixture: 'prompt-typing.json',
      method:
        'Present in both captured states. Text length 0 when empty and 30 ' +
        'after typing — recorded as a length, not as text, under GUARDRAILS ' +
        'G1.2.1.'
    }
  },
  {
    id: 'prompt.rich_textarea',
    file: 'extension-cloudflare/prompt-typing.js',
    selector: RICH_TEXTAREA,
    scope: 'document',
    states: { empty: true, filled: true },
    observed: true,
    evidenceKind: 'captured',
    measured: {
      date: '2026-10-01',
      fixture: 'prompt-typing.json',
      method: 'Present in both states; input-area-v2 also carries classes "single-line-input" and "lm-input-redesign".'
    }
  },
  {
    // The control that decides whether a request is ever sent. This is the
    // selector three live horo_consult calls failed on.
    id: 'prompt.send_button',
    file: 'extension-cloudflare/prompt-typing.js',
    selector: SEND_BUTTON,
    scope: 'document',
    states: { empty: false, filled: true },
    observed: true,
    evidenceKind: 'captured',
    measured: {
      date: '2026-10-01',
      fixture: 'prompt-typing.json',
      method:
        'Absent while the editor is empty; PRESENT and enabled once text has ' +
        'landed. Clicking it cleared the editor and raised the user-query ' +
        'count from 3 to 4, confirming the control submits rather than ' +
        'merely existing. The selector is CORRECT — the three ' +
        'send_button_not_found failures were a precondition state, not a ' +
        'stale selector.'
    }
  },
  {
    // Declared because it exists in the code and is meant to be a safety net.
    // It matched nothing in any captured state, including the one where the
    // button was present and enabled.
    id: 'prompt.send_button_fallback',
    file: 'extension-cloudflare/prompt-typing.js',
    selector: SEND_BUTTON_FALLBACK,
    scope: 'document',
    states: { empty: null, filled: null },
    observed: false,
    unobservedBecause:
      'Matched zero elements in every captured state, including ' +
      'editor_filled where input-area-v2 held an enabled button wrapping a ' +
      'mat-icon named arrow_upward. It provides no fallback on this build: ' +
      'if the primary selector breaks, this cannot catch it. Kept because ' +
      'it is harmless and the control may be named differently on another ' +
      'build — but the record says plainly that today it is decoration, ' +
      'the same criticism this contract already makes of ' +
      'grounding.cite_marker.',
    measured: {
      date: '2026-10-01',
      fixture: 'prompt-typing.json',
      method: 'Queried in all three input-area states; zero matches every time.'
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
      'elements both times. Re-queried across a full generation on ' +
      '2026-10-01 including the thinking phase: still zero. The ' +
      'document-wide fallback still exists and is guarded against the ' +
      'chat-history loader in the sidenav.',
    measured: { date: '2026-09-29', fixture: 'generating-signal.json', method: 'Absent in both captured states; re-confirmed absent 2026-10-01 in prompt-typing.json.' }
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

  // KAN-231: `:has(inner)` — a descendant test. The extension's send-button
  // selector is `input-area-v2 button:has(mat-icon[...="arrow_upward"])`,
  // and a matcher that cannot evaluate `:has()` returns false for it. That is
  // the same class of bug as KAN-198's stub silently failing to match: an
  // unsupported selector form must be loud, not confidently false.
  const has = selector.match(/:has\(([^)]+)\)/);
  let rest = selector;
  if (has) {
    rest = selector.replace(has[0], '').trim();
    const kids = flattenChildren(node);
    if (!kids.some((k) => safeMatch(k, has[1]))) return false;
  }

  const attr = rest.match(/\[([\w-]+)([*^$~]?)=("?)([^"\]]*)\3\]/);
  let base = rest;
  if (attr) {
    base = rest.replace(attr[0], '').trim();
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
 * Match a node against a descendant selector, e.g. `input-area-v2 button:has(...)`.
 *
 * KAN-231. A captured node carries its children, not its parents, so the
 * trailing part has to be tested against the node and the leading part against
 * its ancestors. Testing the node in isolation is what made `:has()` return a
 * confident false on a selector the live page does match.
 */
function matchesDescendant(node, selector) {
  const parts = String(selector).trim().split(/\s+/);
  if (parts.length === 1) return safeMatch(node, selector);
  const tail = parts.pop();
  if (!safeMatch(node, tail)) return false;
  // A descendant combinator is not a parent chain: `a b c` means c anywhere
  // below a, with any number of elements in between. Walking one level at a
  // time demanded a direct parent and reported real matches as absent.
  const needed = parts.length;
  let matched = 0;
  for (let a = node._parent; a; a = a._parent) {
    if (safeMatch(a, parts[needed - 1 - matched])) {
      matched += 1;
      if (matched === needed) return true;
    }
  }
  return false;
}

/** Every descendant of a captured node, depth-first. KAN-231. */
function flattenChildren(node) {
  const out = [];
  const walk = (n) => {
    for (const c of (n && n.children) || []) { out.push(c); walk(c); }
  };
  walk(node);
  return out;
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
  // KAN-231: children are carried through and parents are linked, so both
  // `:has()` (a descendant test) and a descendant selector like
  // `input-area-v2 button` can be evaluated. Previously children were dropped
  // and parents did not exist, which made every such selector silently
  // unmatchable rather than loudly unsupported.
  const link = (n) => {
    const out = { tag: n.tag, class: n.class, attrs: Object.assign({}, n.attrs || {}) };
    out.children = (n.children || []).map((c) => {
      const built = link(c);
      built._parent = out;
      return built;
    });
    return out;
  };
  const nodes = (captured.nodes || []).map(link);
  const allNodes = nodes;

  const container = (children) => {
    // KAN-231: query the whole tree, not just the captured top level. The
    // input-area capture nests the editor three levels down and the send
    // button two, so a top-level-only search reported a real match as absent
    // — the same confidently-false failure as an unsupported selector form.
    const every = [];
    const walk = (n) => { every.push(n); for (const c of n.children || []) walk(c); };
    for (const n of children) walk(n);
    return {
      _nodes: children,
      querySelector(sel) {
        return every.find((n) => matchesDescendant(n, sel)) || null;
      },
      querySelectorAll(sel) {
        if (sel === '*') return every;
        return every.filter((n) => matchesDescendant(n, sel));
      },
      closest() { return null; }
    };
  };

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
