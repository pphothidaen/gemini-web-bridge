// ============================================================
// KAN-243: DO Alarm Webhook Alerting (Sprint 1 Completion)
// Test-Driven Development (TDD) Specification & Red Team Suite
//
// REQUIREMENTS & GUARDRAILS SPECIFIED:
// 1. G1 Zero-Leak Guardrail:
//    - Webhook payload MUST NEVER contain prompt text, user queries, model responses,
//      headers with credentials, or session tokens (SNlM0e).
//    - Only metadata: { event, service: "gemini-web-bridge-cloud-hub", version, timestamp, consecutive_errors, details }.
//    - Includes adversarial assertion scanning JSON payload for any secret tokens, prompts, or sensitive strings.
// 2. Trigger Conditions:
//    - When env.ALERT_WEBHOOK_URL is undefined or empty: alarm() must NOT call fetch() for alerts; executes cleanly.
//    - When activeConnections has an unresponsive connection cleaned up during alarm(): dispatches alert { event: "stale_connection_reaped", instanceId, idleSec }.
//    - When this.metrics.consecutive_errors >= 3: dispatches alert { event: "consecutive_errors_threshold", count, lastError }.
// 3. Anti-Flapping / Debounce:
//    - Webhook must not flood external channels on every 120s alarm tick.
//    - If consecutive_errors remains >= 3 across multiple ticks, debounce window (e.g. 300,000 ms) suppresses duplicate alerts until cooldown expires.
// 4. Non-Blocking / Fail-Open Resilience:
//    - If the webhook HTTP request rejects (network error) or returns 500, alarm() must catch the error, log a warning, and NOT throw or abort keepalive/rescheduling.
// 5. Discord / Slack Format Compatibility:
//    - Payload includes "content" field with human-readable markdown alert so standard Discord/Slack webhook URLs render nicely.
// ============================================================

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import * as modelCatalog from '../src/model-catalog.js';
import * as emulator from '../src/tool-emulator.ts';
import * as pdfLib from 'pdf-lib';
import * as liveness from '../src/liveness.js';
import * as geminiRefusal from '../src/gemini-refusal.js';
import * as promptTemplates from '../src/prompt-templates.js';
import * as horoPrompts from "../src/horo-prompts.js";
import { makeCtx } from './helpers/fake-ctx.mjs';

// ─── Harness & Clock Double ──────────────────────────────────────────

const BASE_TIME = 1_700_000_000_000;
let currentTime = BASE_TIME;
let fetchCalls = [];
let pendingWaitUntils = [];
let fetchHandler = async (url, init) => {
  return new MockResponse(JSON.stringify({ success: true }), { status: 200 });
};

class MockDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(currentTime);
    else super(...args);
  }
  static now() {
    return currentTime;
  }
}

class MockSocket {
  constructor(opts = {}) {
    this.readyState = opts.readyState ?? 1; // 1 = OPEN, 3 = CLOSED
    this.sent = [];
    this.closed = null;
    this.listeners = new Map();
  }
  send(data) {
    if (this.readyState !== 1) throw new Error('WebSocket is not open');
    this.sent.push(data);
  }
  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.closed = { code, reason };
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatch(type, event) {
    for (const fn of this.listeners.get(type) || []) fn(event);
  }
}

class MockResponse {
  constructor(body = null, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = new Headers(init.headers || {});
    this.ok = this.status >= 200 && this.status < 300;
    this.webSocket = init.webSocket ?? null;
  }
  async text() {
    return this.body == null ? '' : String(this.body);
  }
  async json() {
    return JSON.parse(await this.text());
  }
}

function activeFetch(url, init = {}) {
  let headersObj = {};
  if (init.headers) {
    if (typeof init.headers.forEach === 'function') {
      init.headers.forEach((val, key) => {
        headersObj[key.toLowerCase()] = val;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) headersObj[k.toLowerCase()] = v;
    } else if (typeof init.headers === 'object') {
      for (const [k, v] of Object.entries(init.headers)) headersObj[k.toLowerCase()] = v;
    }
  }

  const record = {
    url: String(url),
    method: (init.method || 'GET').toUpperCase(),
    headers: headersObj,
    body: init.body,
    timestamp: currentTime,
  };
  fetchCalls.push(record);
  return fetchHandler(url, init);
}

function resetHarness() {
  currentTime = BASE_TIME;
  fetchCalls = [];
  pendingWaitUntils = [];
  fetchHandler = async () => new MockResponse(JSON.stringify({ success: true }), { status: 200 });
}

beforeEach(() => {
  resetHarness();
});

// ─── DO Sandbox Loader ───────────────────────────────────────────────

const doSource = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const doClassSrc = doSource
  .replace(/import[\s\S]*?from "[^"]+";/g, '')
  .replaceAll('export class ', 'class ')
  .replace('export default {', 'const entry = {');

const workerdCrypto = {
  randomUUID,
  getRandomValues: (arr) => globalThis.crypto.getRandomValues(arr),
  subtle: globalThis.crypto.subtle,
};

function loadDO() {
  const sandbox = {
    ...modelCatalog,
    ...emulator,
    ...pdfLib,
    ...liveness,
    ...geminiRefusal,
    ...promptTemplates,
  ...horoPrompts,
    DurableObject: class {},
    crypto: workerdCrypto,
    Response: MockResponse,
    Request,
    Headers,
    URL,
    TextEncoder,
    TextDecoder,
    TextEncoderStream: class {},
    TransformStream,
    ReadableStream,
    WebSocketPair: class {
      constructor() {
        this[0] = new MockSocket();
        this[1] = new MockSocket();
      }
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => {},
    Date: MockDate,
    fetch: activeFetch,
  };
  sandbox.globalThis = sandbox;
  return vm.runInNewContext(doClassSrc + '\n;({GeminiBridgeDO})', sandbox).GeminiBridgeDO;
}

const GeminiBridgeDO = loadDO();

function createTestCtx(opts = {}) {
  const ctx = makeCtx({ now: () => currentTime, ...opts });
  const origWaitUntil = ctx.waitUntil;
  ctx.waitUntil = (promise) => {
    if (promise && typeof promise.then === 'function') {
      pendingWaitUntils.push(promise);
    }
    if (origWaitUntil) origWaitUntil.call(ctx, promise);
  };
  return ctx;
}

function createBridge(envOverrides = {}, opts = {}) {
  const env = {
    CLIENT_API_KEY: 'test-client-key-xyz-12345',
    BRIDGE_AUTH_TOKEN: 'test-bridge-auth-xyz-67890',
    ALERT_WEBHOOK_URL: 'https://webhook.test/alerts/do-alarm',
    ...envOverrides,
  };
  const ctx = createTestCtx(opts);
  const bridge = new GeminiBridgeDO(ctx, env);
  bridge.waitForExtension = async () => {};
  bridge.currentTokens = { sessionReady: true };
  bridge.currentScope = 'app';
  return bridge;
}

async function runAlarm(bridge) {
  const result = await bridge.alarm();
  if (pendingWaitUntils.length > 0) {
    const promises = [...pendingWaitUntils];
    pendingWaitUntils = [];
    await Promise.allSettled(promises);
  }
  return result;
}

// ─── Adversarial Sensitive Leak Scanner ─────────────────────────────

function scanPayloadForLeaks(payload, sensitiveStrings = []) {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const lower = serialized.toLowerCase();
  for (const secret of sensitiveStrings) {
    if (!secret || secret.length < 4) continue;
    assert.ok(
      !serialized.includes(secret) && !lower.includes(secret.toLowerCase()),
      `G1 LEAK DETECTED: Webhook payload contains sensitive string "${secret}"`
    );
  }
}

// =====================================================================
// 1. TRIGGER CONDITIONS (Requirement 2)
// =====================================================================

test('trigger: alarm executes cleanly and makes 0 fetch calls when ALERT_WEBHOOK_URL is undefined', async () => {
  resetHarness();
  const bridge = createBridge({ ALERT_WEBHOOK_URL: undefined });

  // Simulate conditions that would otherwise trigger an alert:
  // 1) >= 3 consecutive errors
  bridge.recordHealthError('Test Error 1');
  bridge.recordHealthError('Test Error 2');
  bridge.recordHealthError('Test Error 3');

  // 2) Unresponsive stale connection
  const staleSocket = new MockSocket({ readyState: 3 });
  bridge.activeConnections.set('inst_unresponsive_001', {
    socket: staleSocket,
    connectedAt: currentTime - 300_000,
    lastActivityAt: currentTime - 200_000,
    lastPingAt: currentTime - 45_000,
    lastPongAt: currentTime - 200_000,
    epoch: 0,
  });

  await runAlarm(bridge);

  assert.equal(fetchCalls.length, 0, 'alarm() must NOT call fetch() when ALERT_WEBHOOK_URL is undefined');
});

test('trigger: alarm executes cleanly and makes 0 fetch calls when ALERT_WEBHOOK_URL is empty string', async () => {
  resetHarness();
  const bridge = createBridge({ ALERT_WEBHOOK_URL: '' });

  bridge.recordHealthError('Outage 1');
  bridge.recordHealthError('Outage 2');
  bridge.recordHealthError('Outage 3');

  await runAlarm(bridge);

  assert.equal(fetchCalls.length, 0, 'alarm() must NOT call fetch() when ALERT_WEBHOOK_URL is empty string');
});

test('trigger: dispatches stale_connection_reaped alert when an unresponsive connection is cleaned up', async () => {
  resetHarness();
  const webhookUrl = 'https://webhook.test/alerts/stale-connection';
  const bridge = createBridge({ ALERT_WEBHOOK_URL: webhookUrl });

  // Add an unresponsive connection: socket is dead (readyState 3) and idle past threshold
  const staleInstanceId = 'instance-dead-99';
  const staleIdleSec = 210;
  const staleSocket = new MockSocket({ readyState: 3 });

  bridge.activeConnections.set(staleInstanceId, {
    socket: staleSocket,
    connectedAt: currentTime - (staleIdleSec + 50) * 1000,
    lastActivityAt: currentTime - staleIdleSec * 1000,
    lastPingAt: currentTime - 45_000,
    lastPongAt: currentTime - 200_000,
    epoch: 0,
  });

  await runAlarm(bridge);

  // The stale connection must be reaped from activeConnections
  assert.equal(bridge.activeConnections.has(staleInstanceId), false, 'stale connection must be deleted');

  // Must dispatch alert to webhookUrl
  const alertCalls = fetchCalls.filter((c) => c.url === webhookUrl);
  assert.equal(alertCalls.length, 1, 'must dispatch exactly 1 webhook alert for reaped connection');

  const payload = JSON.parse(alertCalls[0].body);
  assert.equal(payload.event, 'stale_connection_reaped');
  assert.equal(payload.service, 'gemini-web-bridge-cloud-hub');

  const instanceId = payload.details?.instanceId ?? payload.instanceId;
  const idleSec = payload.details?.idleSec ?? payload.idleSec;

  assert.equal(instanceId, staleInstanceId, 'payload must identify the reaped instanceId');
  assert.ok(typeof idleSec === 'number' && idleSec >= 180, `idleSec must be a number >= 180, got ${idleSec}`);
});

test('trigger: does NOT dispatch stale_connection_reaped alert for healthy responsive connections', async () => {
  resetHarness();
  const webhookUrl = 'https://webhook.test/alerts/healthy';
  const bridge = createBridge({ ALERT_WEBHOOK_URL: webhookUrl });

  // Add healthy active connection that answers ping
  const healthySocket = new MockSocket({ readyState: 1 });
  bridge.activeConnections.set('instance-live-01', {
    socket: healthySocket,
    connectedAt: currentTime - 120_000,
    lastActivityAt: currentTime - 10_000,
    lastPingAt: currentTime - 1_000,
    lastPongAt: currentTime - 900,
    epoch: 0,
  });

  await runAlarm(bridge);

  assert.equal(bridge.activeConnections.has('instance-live-01'), true, 'healthy connection must stay connected');
  assert.equal(fetchCalls.length, 0, 'must NOT dispatch alert when no stale connections are reaped');
});

test('trigger: does NOT dispatch consecutive_errors_threshold alert when consecutive_errors < 3', async () => {
  resetHarness();
  const bridge = createBridge();

  // Record only 2 errors (below threshold of 3)
  bridge.recordHealthError('Temporary glitch 1');
  bridge.recordHealthError('Temporary glitch 2');

  await runAlarm(bridge);

  const errorAlerts = fetchCalls.filter((c) => {
    try {
      const p = JSON.parse(c.body);
      return p.event === 'consecutive_errors_threshold';
    } catch {
      return false;
    }
  });

  assert.equal(errorAlerts.length, 0, 'must NOT alert when consecutive_errors is below 3');
});

test('trigger: dispatches consecutive_errors_threshold alert when consecutive_errors reaches 3 or more', async () => {
  resetHarness();
  const webhookUrl = 'https://webhook.test/alerts/errors';
  const bridge = createBridge({ ALERT_WEBHOOK_URL: webhookUrl });

  // Record 3 consecutive errors
  const lastErrorMessage = 'Extension response timeout: execution failed after 30s';
  bridge.recordHealthError('Initial handshake failure');
  bridge.recordHealthError('Tab execution crashed');
  bridge.recordHealthError(lastErrorMessage);

  // If DO supports metrics property or getter, ensure it reflects consecutive_errors >= 3
  if (bridge.metrics) {
    bridge.metrics.consecutive_errors = 3;
    bridge.metrics.last_error = lastErrorMessage;
  }

  await runAlarm(bridge);

  const alertCalls = fetchCalls.filter((c) => c.url === webhookUrl);
  assert.equal(alertCalls.length, 1, 'must dispatch alert when consecutive_errors reaches 3');

  const payload = JSON.parse(alertCalls[0].body);
  assert.equal(payload.event, 'consecutive_errors_threshold');
  assert.equal(payload.service, 'gemini-web-bridge-cloud-hub');

  const count = payload.details?.count ?? payload.count ?? payload.consecutive_errors;
  const lastError = payload.details?.lastError ?? payload.lastError;

  assert.ok(count >= 3, `count in alert must be >= 3, got ${count}`);
  assert.equal(lastError, lastErrorMessage, 'payload must record lastError');
});

// =====================================================================
// 2. G1 ZERO-LEAK GUARDRAIL & ADVERSARIAL PROTECTION (Requirement 1)
// =====================================================================

test('G1 guardrail: webhook payload schema is strictly limited to allowed metadata and content', async () => {
  resetHarness();
  const bridge = createBridge();

  bridge.recordHealthError('Database lock error');
  bridge.recordHealthError('Database lock error');
  bridge.recordHealthError('Database lock error');

  await runAlarm(bridge);

  assert.ok(fetchCalls.length > 0, 'alert must have fired to test payload schema');
  const payload = JSON.parse(fetchCalls[0].body);

  // Requirement 1: Only metadata: { event, service: "gemini-web-bridge-cloud-hub", version, timestamp, consecutive_errors, details }
  // Requirement 5: Payload includes "content" field with human-readable markdown alert
  const allowedKeys = new Set([
    'event',
    'service',
    'version',
    'timestamp',
    'consecutive_errors',
    'details',
    'content',
    'instanceId',
    'idleSec',
    'count',
    'lastError',
  ]);

  const actualKeys = Object.keys(payload);
  for (const key of actualKeys) {
    assert.ok(
      allowedKeys.has(key),
      `G1 Violation: Disallowed top-level property "${key}" in webhook payload: ${JSON.stringify(payload)}`
    );
  }

  // Strictly forbid sensitive credential / query / prompt fields
  const forbiddenKeywords = [
    'prompt',
    'prompts',
    'query',
    'queries',
    'response',
    'responses',
    'cookie',
    'cookies',
    'token',
    'tokens',
    'snlm0e',
    'auth',
    'authorization',
    'headers',
    'credentials',
    'apikey',
    'api_key',
    'secret',
  ];

  for (const forbidden of forbiddenKeywords) {
    assert.equal(payload[forbidden], undefined, `Payload top-level must NEVER contain key "${forbidden}"`);
    if (payload.details && typeof payload.details === 'object') {
      assert.equal(payload.details[forbidden], undefined, `Payload details must NEVER contain key "${forbidden}"`);
    }
  }

  assert.equal(payload.service, 'gemini-web-bridge-cloud-hub');
  assert.ok(typeof payload.version === 'string' && payload.version.length > 0, 'version must be non-empty string');
  assert.ok(
    typeof payload.timestamp === 'number' || typeof payload.timestamp === 'string',
    'timestamp must be number or ISO string'
  );
  assert.ok(typeof payload.consecutive_errors === 'number', 'consecutive_errors must be a number');
  assert.ok(typeof payload.details === 'object' && payload.details !== null, 'details must be an object');
});

test('G1 adversarial: webhook payload NEVER leaks prompt text, user queries, model responses, headers, or SNlM0e tokens', async () => {
  resetHarness();

  const SENSITIVE_STRINGS = [
    'SNlM0e=AIzaSyD_ADVERSARIAL_SESSION_COOKIE_SECRET_TOKEN_9999',
    'CONFIDENTIAL_USER_PROMPT_DO_NOT_EXPOSE_PROPRIETARY_DATA',
    'SECRET_BANKING_USER_QUERY_ACCOUNT_BALANCE_7777',
    'SENSITIVE_AI_MODEL_GENERATED_RESPONSE_TOP_SECRET_CODE',
    'super-secret-client-api-key-8888',
    'super-secret-bridge-token-5555',
    'Bearer adversarial-auth-secret-token',
  ];

  const bridge = createBridge({
    CLIENT_API_KEY: 'super-secret-client-api-key-8888',
    BRIDGE_AUTH_TOKEN: 'super-secret-bridge-token-5555',
  });

  // Inject sensitive data into DO session state, tokens, and active connections
  bridge.currentTokens = {
    sessionReady: true,
    SNlM0e: 'SNlM0e=AIzaSyD_ADVERSARIAL_SESSION_COOKIE_SECRET_TOKEN_9999',
    rawCookie: 'HSID=test; SNlM0e=AIzaSyD_ADVERSARIAL_SESSION_COOKIE_SECRET_TOKEN_9999',
  };

  const deadSocket = new MockSocket({ readyState: 3 });
  bridge.activeConnections.set('adversarial-inst-01', {
    socket: deadSocket,
    connectedAt: currentTime - 300_000,
    lastActivityAt: currentTime - 200_000,
    lastPingAt: currentTime - 45_000,
    lastPongAt: currentTime - 200_000,
    epoch: 1,
    tokens: 'SNlM0e=AIzaSyD_ADVERSARIAL_SESSION_COOKIE_SECRET_TOKEN_9999',
    lastPrompt: 'CONFIDENTIAL_USER_PROMPT_DO_NOT_EXPOSE_PROPRIETARY_DATA',
    lastQuery: 'SECRET_BANKING_USER_QUERY_ACCOUNT_BALANCE_7777',
  });

  bridge.lastModelResponse = 'SENSITIVE_AI_MODEL_GENERATED_RESPONSE_TOP_SECRET_CODE';
  bridge.pendingRequests = [
    {
      prompt: 'CONFIDENTIAL_USER_PROMPT_DO_NOT_EXPOSE_PROPRIETARY_DATA',
      query: 'SECRET_BANKING_USER_QUERY_ACCOUNT_BALANCE_7777',
    },
  ];

  bridge.recordHealthError('Upstream connection error 1');
  bridge.recordHealthError('Upstream connection error 2');
  bridge.recordHealthError('Upstream connection error 3');

  await runAlarm(bridge);

  assert.ok(fetchCalls.length > 0, 'alert must have fired during adversarial test');

  for (const call of fetchCalls) {
    // Scan full serialized payload
    scanPayloadForLeaks(call.body, SENSITIVE_STRINGS);

    const parsed = JSON.parse(call.body);
    // Scan content field
    if (parsed.content) {
      scanPayloadForLeaks(parsed.content, SENSITIVE_STRINGS);
    }
    // Scan details object
    if (parsed.details) {
      scanPayloadForLeaks(parsed.details, SENSITIVE_STRINGS);
    }

    // Scan headers sent in outgoing fetch
    const headersString = JSON.stringify(call.headers);
    scanPayloadForLeaks(headersString, SENSITIVE_STRINGS);
  }
});

// =====================================================================
// 3. ANTI-FLAPPING / DEBOUNCE (Requirement 3)
// =====================================================================

test('anti-flapping: consecutive_errors alert is debounced across repeated alarm ticks within 300,000ms window', async () => {
  resetHarness();
  const bridge = createBridge();

  bridge.recordHealthError('Continuous persistent downstream error');
  bridge.recordHealthError('Continuous persistent downstream error');
  bridge.recordHealthError('Continuous persistent downstream error');

  // Tick 1 (t = 0): First alarm firing -> Should dispatch alert #1
  await runAlarm(bridge);
  assert.equal(fetchCalls.length, 1, 'Tick 1: must dispatch alert when consecutive_errors reaches 3');

  // Tick 2 (t = 120s): Standard 120s alarm interval. Error state remains >= 3.
  currentTime += 120_000;
  await runAlarm(bridge);
  assert.equal(
    fetchCalls.length,
    1,
    'Tick 2 (120s later): must suppress duplicate alert within 300,000ms debounce window'
  );

  // Tick 3 (t = 240s): Still within 300,000ms debounce cooldown.
  currentTime += 120_000;
  await runAlarm(bridge);
  assert.equal(
    fetchCalls.length,
    1,
    'Tick 3 (240s later): must suppress duplicate alert within 300,000ms debounce window'
  );
});

test('anti-flapping: dispatches new alert after 300,000ms debounce cooldown window expires', async () => {
  resetHarness();
  const bridge = createBridge();

  bridge.recordHealthError('Outage error');
  bridge.recordHealthError('Outage error');
  bridge.recordHealthError('Outage error');

  // Tick 1 (t = 0): Initial alert
  await runAlarm(bridge);
  assert.equal(fetchCalls.length, 1, 'Tick 1: initial alert dispatched');

  // Advance time past 300,000ms cooldown (e.g. 300,001 ms)
  currentTime += 300_001;
  await runAlarm(bridge);

  assert.equal(
    fetchCalls.length,
    2,
    'Tick 2 (300,001ms later): must dispatch a new alert once debounce cooldown has expired'
  );

  const secondPayload = JSON.parse(fetchCalls[1].body);
  assert.equal(secondPayload.event, 'consecutive_errors_threshold');
});

// =====================================================================
// 4. NON-BLOCKING / FAIL-OPEN RESILIENCE (Requirement 4)
// =====================================================================

test('resilience: alarm() catches network fetch rejection, logs warning, and does NOT throw or abort rescheduling', async () => {
  resetHarness();
  const bridge = createBridge();

  // Configure fetch to reject with simulated network outage
  fetchHandler = async () => {
    throw new TypeError('fetch failed: network connection refused (simulated webhook outage)');
  };

  const capturedWarnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    capturedWarnings.push(args.join(' '));
    originalWarn(...args);
  };

  try {
    bridge.recordHealthError('Simulated outage error 1');
    bridge.recordHealthError('Simulated outage error 2');
    bridge.recordHealthError('Simulated outage error 3');

    // Keep an active socket so alarm rescheduling is expected to happen
    bridge.activeSocket = new MockSocket({ readyState: 1 });

    // alarm() must NOT throw even though webhook fetch rejects
    await assert.doesNotReject(
      async () => {
        await runAlarm(bridge);
      },
      'alarm() must be fail-open and catch webhook errors without rethrowing'
    );

    // Verify webhook fetch was attempted
    assert.equal(fetchCalls.length, 1, 'webhook fetch must have been attempted');

    // Verify warning was logged
    assert.ok(
      capturedWarnings.some((w) => /webhook|alert|alarm/i.test(w)),
      'a warning must be logged when webhook delivery fails'
    );

    // Verify alarm rescheduling was NOT aborted
    const setAlarmCalls = bridge.ctx.__calls?.setAlarm || [];
    assert.ok(
      setAlarmCalls.length > 0 || bridge.ctx.__pendingAlarm() !== null,
      'alarm rescheduling must still execute even when webhook delivery fails'
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('resilience: alarm() catches HTTP 500 error response, logs warning, and does NOT throw or abort rescheduling', async () => {
  resetHarness();
  const bridge = createBridge();

  // Configure fetch to return HTTP 500
  fetchHandler = async () => {
    return new MockResponse('Internal Server Error', { status: 500 });
  };

  const capturedWarnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    capturedWarnings.push(args.join(' '));
    originalWarn(...args);
  };

  try {
    bridge.recordHealthError('Outage 1');
    bridge.recordHealthError('Outage 2');
    bridge.recordHealthError('Outage 3');

    bridge.activeSocket = new MockSocket({ readyState: 1 });

    await assert.doesNotReject(
      async () => {
        await runAlarm(bridge);
      },
      'alarm() must handle HTTP 500 response without throwing'
    );

    assert.equal(fetchCalls.length, 1, 'webhook fetch must have been attempted');

    assert.ok(
      capturedWarnings.some((w) => /webhook|alert|500|failed/i.test(w)),
      'a warning must be logged when webhook returns HTTP error'
    );

    const setAlarmCalls = bridge.ctx.__calls?.setAlarm || [];
    assert.ok(
      setAlarmCalls.length > 0 || bridge.ctx.__pendingAlarm() !== null,
      'alarm rescheduling must still succeed when webhook returns 500'
    );
  } finally {
    console.warn = originalWarn;
  }
});

// =====================================================================
// 5. DISCORD / SLACK FORMAT COMPATIBILITY (Requirement 5)
// =====================================================================

test('format compatibility: webhook sends HTTP POST with Content-Type application/json', async () => {
  resetHarness();
  const webhookUrl = 'https://discord.com/api/webhooks/12345/abcdef-token';
  const bridge = createBridge({ ALERT_WEBHOOK_URL: webhookUrl });

  bridge.recordHealthError('Error 1');
  bridge.recordHealthError('Error 2');
  bridge.recordHealthError('Error 3');

  await runAlarm(bridge);

  const calls = fetchCalls.filter((c) => c.url === webhookUrl);
  assert.equal(calls.length, 1, 'must call configured webhook URL');

  assert.equal(calls[0].method, 'POST', 'webhook request must be HTTP POST');
  const contentType = calls[0].headers['content-type'];
  assert.ok(
    contentType && contentType.includes('application/json'),
    `Content-Type header must contain application/json, got "${contentType}"`
  );
});

test('format compatibility: payload includes markdown "content" field compatible with Discord and Slack webhooks (<= 2000 chars)', async () => {
  resetHarness();
  const webhookUrl = 'https://hooks.slack.com/services/T00/B00/XXXX';
  const bridge = createBridge({ ALERT_WEBHOOK_URL: webhookUrl });

  // Test Case A: consecutive_errors_threshold event
  bridge.recordHealthError('E1');
  bridge.recordHealthError('E2');
  bridge.recordHealthError('Tab execution crashed');

  await runAlarm(bridge);

  assert.equal(fetchCalls.length, 1);
  const errorPayload = JSON.parse(fetchCalls[0].body);

  assert.ok(typeof errorPayload.content === 'string', 'payload must include a string "content" field');
  assert.ok(errorPayload.content.length > 0, '"content" field must not be empty');
  assert.ok(
    errorPayload.content.length <= 2000,
    `"content" field must not exceed 2000 characters for Discord compatibility, got ${errorPayload.content.length}`
  );
  // Markdown indicators: bolding (**), code (`), headers (#), or bullet points
  assert.ok(
    /[*`_#]/.test(errorPayload.content),
    `"content" should contain markdown formatting, got: ${errorPayload.content}`
  );
  assert.match(
    errorPayload.content,
    /error|alert|gemini-web-bridge/i,
    '"content" must describe the error alert event'
  );

  // Test Case B: stale_connection_reaped event
  resetHarness();
  const bridge2 = createBridge({ ALERT_WEBHOOK_URL: webhookUrl });
  const staleId = 'inst_reap_compatibility_001';
  bridge2.activeConnections.set(staleId, {
    socket: new MockSocket({ readyState: 3 }),
    connectedAt: currentTime - 250_000,
    lastActivityAt: currentTime - 200_000,
    lastPingAt: currentTime - 45_000,
    lastPongAt: currentTime - 200_000,
    epoch: 0,
  });

  await runAlarm(bridge2);

  assert.equal(fetchCalls.length, 1);
  const stalePayload = JSON.parse(fetchCalls[0].body);

  assert.ok(typeof stalePayload.content === 'string', 'stale alert payload must include "content" field');
  assert.ok(stalePayload.content.length > 0, '"content" field must not be empty');
  assert.ok(
    stalePayload.content.length <= 2000,
    `"content" field must not exceed 2000 characters for Discord compatibility, got ${stalePayload.content.length}`
  );
  assert.match(
    stalePayload.content,
    /stale|reaped|connection/i,
    '"content" must describe the stale connection event'
  );
});
