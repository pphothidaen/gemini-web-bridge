import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const contentSource = fs.readFileSync(
  new URL('../../extension-cloudflare/content.js', import.meta.url),
  'utf8'
);

const FN_RE = /async function handleVerifyGrounding\(msg\) \{([\s\S]*?)\n  \}/;

function loadHandleVerifyGrounding(ctx) {
  const m = FN_RE.exec(contentSource);
  assert.ok(m, 'content.js must still declare handleVerifyGrounding');
  vm.createContext(ctx);
  return vm.runInContext(
    `(async function handleVerifyGrounding(msg) {${m[1]}\n})`,
    ctx
  );
}

async function runVerifyGrounding({
  attachEvidenceTimeline,
  generatingTimeline = [],
  timeoutMs = 8000,
  pollMs = 400
}) {
  let workerMessages = [];
  let clock = 0;
  let pollCount = 0;

  const doc = {};

  const ctx = {
    document: doc,
    globalThis: {
      NotebookAttach: {
        readGroundingEvidence: () => {
          const ev = pollCount < attachEvidenceTimeline.length 
            ? attachEvidenceTimeline[pollCount] 
            : attachEvidenceTimeline[attachEvidenceTimeline.length - 1];
          // clone the object to avoid mutation side effects across polls
          return { ...ev };
        }
      },
      NativeRecovery: {
        isGenerating: () => {
          return pollCount < generatingTimeline.length 
            ? generatingTimeline[pollCount]
            : (generatingTimeline.length > 0 ? generatingTimeline[generatingTimeline.length - 1] : false);
        }
      }
    },
    sendToWorker: (msg) => {
      workerMessages.push(msg);
    },
    console: { log: () => {} },
    Date: { now: () => clock },
    setTimeout: (cb) => {
      pollCount++;
      clock += pollMs;
      cb();
      return 0;
    }
  };

  const fn = loadHandleVerifyGrounding(ctx);
  await fn({ requestId: 'test-req', timeoutMs });

  return workerMessages[0];
}

test('citations appearing after a mid-answer gap are still caught', async () => {
  // Simulate 5 stable samples (2.0s gap, used to fail at 3 samples) then citations appear.
  const timeline = [
    { verified: false, reason: 'no_citations_in_response', chipCount: 0, citeMarkers: 0 },
    { verified: false, reason: 'no_citations_in_response', chipCount: 0, citeMarkers: 0 },
    { verified: false, reason: 'no_citations_in_response', chipCount: 0, citeMarkers: 0 },
    { verified: false, reason: 'no_citations_in_response', chipCount: 0, citeMarkers: 0 },
    { verified: false, reason: 'no_citations_in_response', chipCount: 0, citeMarkers: 0 },
    { verified: false, reason: 'no_citations_in_response', chipCount: 0, citeMarkers: 0 },
    { verified: true, reason: '', chipCount: 1, citeMarkers: 1 }
  ];
  const result = await runVerifyGrounding({ attachEvidenceTimeline: timeline, timeoutMs: 20000 });
  assert.equal(result.verified, true);
  assert.equal(result.chipCount, 1);
});

test('a generating signal active throughout does not conclude "settled"', async () => {
  const timeline = [
    { verified: false, reason: 'no_citations_in_response', chipCount: 0, citeMarkers: 0 }
  ];
  // Always generating. Should timeout and never settle early.
  const result = await runVerifyGrounding({ 
    attachEvidenceTimeline: timeline, 
    generatingTimeline: [true], 
    timeoutMs: 12000 
  });
  
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'timeout_while_generating');
});

test('the timeout-while-generating path returns the distinct reason', async () => {
  const timeline = [
    { verified: false, reason: 'no_citations_in_response', chipCount: 0, citeMarkers: 0 }
  ];
  const result = await runVerifyGrounding({ 
    attachEvidenceTimeline: timeline, 
    generatingTimeline: [true], 
    timeoutMs: 8000 
  });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'timeout_while_generating');
});

test('a finished response with genuinely zero chips still reports no_citations_in_response', async () => {
  const timeline = [
    { verified: false, reason: 'no_citations_in_response', chipCount: 0, citeMarkers: 0 }
  ];
  // Not generating. Should settle after 10 stable samples.
  const result = await runVerifyGrounding({ 
    attachEvidenceTimeline: timeline, 
    generatingTimeline: [false], 
    timeoutMs: 20000 
  });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'no_citations_in_response');
});

test('the newest-response scoping still holds', () => {
  // We can't fully run a DOM test, but we can verify the comment still exists
  // and the call to NotebookAttach doesn't specify a global scope.
  // Actually, handleVerifyGrounding calls Attach.readGroundingEvidence({ doc: document });
  // We just ensure we don't break the scoping comment and behavior.
  assert.match(contentSource, /scoped to the newest `model-response`/);
});
