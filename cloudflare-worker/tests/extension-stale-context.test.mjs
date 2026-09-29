/**
 * A dead extension context must be visible, not inferred.
 *
 * When the extension is reloaded at `chrome://extensions`, Chrome invalidates
 * every live content script: `chrome.runtime.id` becomes undefined and every
 * later `chrome.*` call throws. The page keeps the old script, and the script
 * has no way to re-inject itself — only a tab reload can.
 *
 * Before this was handled, the failure was near-invisible. Observed live on
 * 2026-09-29:
 *
 *     worker health      -> extension_status: DISCONNECTED
 *     content indicator  -> "Bridge: Online (3.8 Flash)"   <-- a lie
 *
 * The content script never receives a disconnect notice, so it keeps
 * rendering the last state it was told. Anyone checking the UI concludes the
 * bridge is fine. Worse, `initCentralCoordinator` retried its `connect()`
 * on an interval against a runtime that no longer existed, producing an
 * endless stream of identical warnings that all said the same unactionable
 * thing: "Attempting reconnect...".
 *
 * The fix is to detect the dead context at each reconnect site and say so
 * once, on the indicator, with the remedy. These tests pin that the
 * detection exists on every path that used to loop or fall through quietly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const contentSource = fs.readFileSync(
  new URL('../../extension-cloudflare/content.js', import.meta.url),
  'utf8'
);

/** The guard that distinguishes "retry" from "the extension is gone". */
const CONTEXT_GUARD = 'Boolean(chrome.runtime?.id)';

test('a stale context puts a distinct state on the indicator', () => {
  // "stale" has to be its own status, not a reuse of "disconnected" or
  // "error": those mean "the bridge is down, retrying", and would send the
  // reader back to waiting rather than to reloading the tab.
  assert.match(contentSource, /createOrUpdateIndicator\(\s*"stale"/);
  assert.match(contentSource, /status === "stale"/);
});

test('the stale state is visually distinct from healthy', () => {
  // "connected" is #10b981. A stale script must not render in the same
  // green the healthy state uses.
  const staleBlock = /status === "stale"\)\s*\{([\s\S]*?)\}/.exec(contentSource);
  assert.ok(staleBlock, 'the stale branch must exist in the indicator');
  assert.match(staleBlock[1], /dotColor\s*=\s*"#[0-9a-fA-F]{6}"/);
  assert.doesNotMatch(staleBlock[1], /#10b981/);
});

test('the indicator tells the user what to actually do', () => {
  // "Reload this tab" — not "reload the extension". Reloading the extension
  // is what caused the state, so suggesting it would be actively wrong.
  assert.match(contentSource, /Reload this tab/i);
});

test('every reconnect site checks the context before retrying', () => {
  // The original defect was an unguarded retry that could not succeed. Each
  // `setTimeout(init*Port|Coordinator, 1000)` must sit inside a branch that
  // has already established the runtime is still alive.
  const retries = [...contentSource.matchAll(
    /setTimeout\((initBridgePort|initCentralCoordinator),\s*1000\)/g
  )];
  assert.ok(retries.length >= 3, `expected several retry sites, found ${retries.length}`);

  for (const m of retries) {
    const before = contentSource.slice(Math.max(0, m.index - 400), m.index);
    assert.match(
      before,
      new RegExp(CONTEXT_GUARD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `a retry of ${m[1]} is not guarded by ${CONTEXT_GUARD}`
    );
  }
});

test('the coordinator catch also detects a dead context', () => {
  // initCentralCoordinator's catch was the noisiest symptom: it logged the
  // same warning forever. It must branch on a missing runtime too.
  const catchBlock = /Could not connect to background coordinator[\s\S]{0,400}?\}\s*$/m;
  assert.ok(catchBlock, 'coordinator catch must exist');
  const idx = contentSource.indexOf('Could not connect to background coordinator');
  const region = contentSource.slice(idx - 200, idx + 200);
  assert.match(region, /markExtensionStale/);
});

test('the stale notice fires at most once', () => {
  // Reconnect attempts repeat. Rewriting the indicator each time would
  // flicker it and spam the console, so the notice is latched.
  assert.match(contentSource, /if \(staleNoticeShown\) return;/);
  assert.match(contentSource, /staleNoticeShown = true;/);
});

test('the notice cannot break the reconnect path', () => {
  // Cosmetic failure must not take down the thing that is trying to recover.
  const fn = /function markExtensionStale\([\s\S]*?\n  \}/.exec(contentSource);
  assert.ok(fn, 'markExtensionStale must exist');
  assert.match(fn[0], /try\s*\{[\s\S]*?createOrUpdateIndicator\([\s\S]*?\}\s*catch/);
});

test('the latching flag is declared before the paths that read it', () => {
  // `let` is in its temporal dead zone until the declaration runs. The
  // reconnect paths are function-scoped and can execute during init, so the
  // flag has to be initialised above them, not below.
  const decl = contentSource.indexOf('let staleNoticeShown = false;');
  const firstCall = contentSource.indexOf('markExtensionStale(e)', decl - 60000);
  assert.ok(decl > -1, 'the latch must be declared');
  assert.ok(
    decl < firstCall,
    'staleNoticeShown must be declared before the reconnect paths can read it'
  );
});
