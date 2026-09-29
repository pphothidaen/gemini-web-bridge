/**
 * Auto-focus must fail loudly, not quietly.
 *
 * `handleAttachNotebook` and `handleTypePrompt` ask the background script to
 * foreground the Chrome tab, then poll `document.visibilityState` for up to
 * 2s. The focus request is a side effect the content script does not control,
 * so it can simply never happen — the user has Chrome in a different
 * Space, the OS is refusing the focus, the tab was closed mid-request.
 *
 * The first version of this change polled and then *discarded the boolean*:
 *
 *     requestTabFocus();
 *     await waitForTabVisible(2000);          // result dropped
 *     outcome = await Attach.attachNotebook(...)
 *
 * which made the wait purely cosmetic. A tab that never came forward still
 * ran the whole attach path and failed much later, inside the module, as
 * `tab_not_visible` — the same reason a genuinely hidden tab produces. The
 * log then reads like a UI/selector problem when the real cause is "Chrome
 * never focused the tab", and the two are indistinguishable after the fact.
 *
 * These tests pin the bail: both handlers must short-circuit on a timeout,
 * and neither may touch the module they would otherwise call.
 *
 * content.js is a side-effecting IIFE and exports nothing, so — as
 * backoff-consistency.test.mjs already does for the inline Settings
 * fallback — the function is lifted out of the source and run in a vm.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const contentSource = fs.readFileSync(
  new URL('../../extension-cloudflare/content.js', import.meta.url),
  'utf8'
);

const FN_RE = /async function waitForTabVisible\(([\s\S]*?)\)\s*\{([\s\S]*?)\n  \}/;

/** Build waitForTabVisible from the real source, bound to a fake `document`. */
function loadWaitForTabVisible(ctx) {
  const m = FN_RE.exec(contentSource);
  assert.ok(m, 'content.js must still declare waitForTabVisible');
  vm.createContext(ctx);
  return vm.runInContext(
    `(async function waitForTabVisible(${m[1]}) {${m[2]}\n})`,
    ctx
  );
}

/**
 * Run waitForTabVisible against a fake `document`. `states` is consumed one
 * entry per poll, so a test can describe the tab coming forward after N
 * polls, or never at all.
 *
 * Date is faked too: the never-visible case would otherwise sit through its
 * full 2s timeout for real, which is two wasted seconds on every test run.
 */
async function runWaitForTabVisible({ states, timeoutMs = 2000, pollMs = 50 }) {
  let i = 0;
  let clock = 0;
  const doc = {
    get visibilityState() {
      return i < states.length ? states[i++] : states[states.length - 1];
    }
  };

  const fn = loadWaitForTabVisible({
    document: doc,
    // Each poll advances the clock by pollMs, exactly as a real wait would.
    Date: { now: () => clock },
    setTimeout: (cb) => {
      i++;
      clock += pollMs;
      cb();
      return 0;
    }
  });
  return fn(timeoutMs, pollMs);
}

/** True when a handler guards on the result of waitForTabVisible. */
function handlerBailsOnTimeout(fnName) {
  const start = contentSource.indexOf(`async function ${fnName}(`);
  assert.ok(start > -1, `content.js must still declare ${fnName}`);
  const body = contentSource.slice(start, contentSource.indexOf('\n  }', start));
  return /if\s*\(\s*!\s*\(\s*await\s+waitForTabVisible\(/.test(body);
}

test('a tab already in the foreground returns immediately', async () => {
  assert.equal(await runWaitForTabVisible({ states: ['visible'] }), true);
});

test('a tab that comes forward after two polls is waited for', async () => {
  // This is the case the original change was written for: the fixed 200ms
  // sleep was too short for a cold focus, and the tab is visible by the time
  // anything tries to drive it.
  assert.equal(
    await runWaitForTabVisible({ states: ['hidden', 'hidden', 'visible'] }),
    true
  );
});

test('a tab that never comes forward returns false rather than true', async () => {
  // The load-bearing assertion. `false` is what lets the caller bail; a
  // helper that returned true on timeout would defeat the entire fix while
  // still looking correct in the happy path.
  assert.equal(
    await runWaitForTabVisible({ states: ['hidden', 'hidden', 'hidden'] }),
    false
  );
});

test('a document without the Page Visibility API is treated as visible', async () => {
  // Same rule the modules' isTabVisible() uses: absence of evidence is not
  // evidence of a hidden tab. Test rigs and some embedders have no
  // visibilityState, and failing closed there would wedge every environment.
  const fn = loadWaitForTabVisible({
    document: {},
    Date,
    setTimeout: (cb) => { cb(); return 0; }
  });
  assert.equal(await fn(2000, 50), true);
});

test('the wait does not exceed its own timeout', async () => {
  // Guards against an off-by-one in the deadline comparison: a loop that
  // polls forever would hang the bridge rather than fail it.
  const start = Date.now();
  assert.equal(await runWaitForTabVisible({ states: ['hidden'], timeoutMs: 50 }), false);
  assert.ok(Date.now() - start < 1000, 'must bail promptly on timeout');
});

test('handleAttachNotebook bails when the tab never becomes visible', () => {
  assert.ok(
    handlerBailsOnTimeout('handleAttachNotebook'),
    'handleAttachNotebook must guard on the wait result, not discard it — ' +
      'otherwise a failed focus surfaces as tab_not_visible and hides the cause'
  );
});

test('handleTypePrompt bails when the tab never becomes visible', () => {
  assert.ok(
    handlerBailsOnTimeout('handleTypePrompt'),
    'handleTypePrompt must guard on the wait result, not discard it'
  );
});

test('the timeout reason is distinguishable from a plain hidden tab', () => {
  // `tab_not_visible` means "hidden at check time"; `tab_never_visible`
  // means "we asked Chrome to focus it and it never did". Collapsing them
  // loses the only signal that distinguishes a broken focus request from a
  // user simply being on another tab.
  assert.match(contentSource, /tab_never_visible/);
  assert.match(contentSource, /reason:\s*err\?\.message/);
});

test('a bail carries step "visibility" so it groups with the other guard', () => {
  // The modules return step:"visibility" for the same class of failure;
  // anything else breaks log grouping and the worker's diagnostics.
  const m = /throw Object\.assign\(new Error\("tab_never_visible"\), \{ step: "(\w+)" \}\)/g;
  const found = [...contentSource.matchAll(m)].map((x) => x[1]);
  assert.equal(found.length, 2, 'both handlers must bail with an explicit step');
  for (const s of found) assert.equal(s, 'visibility');
});
