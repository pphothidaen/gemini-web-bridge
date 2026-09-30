// ============================================================
// In-process mock worker harness (no server, no network, no workerd).
//
// Loads the REAL GeminiBridgeDO from src/index.js into a VM sandbox
// (same proven technique as bridge-handshake.test.mjs) and drives it
// directly, so the 5 live-server integration cases can be exercised
// fully in-process with injectable artificial delay.
//
// Delay injection: `TEST_MOCK_DELAY_MS` / setDelay(ms) delays every
// HTTP round-trip through mockFetch; a fake extension client can add
// its own reply latency via onExecute -> { text, delayMs }.
// ============================================================

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import * as modelCatalog from '../../src/model-catalog.js';
import * as emulator from '../../src/tool-emulator.ts';
import * as pdfLib from 'pdf-lib';
import * as liveness from '../../src/liveness.js';
import * as geminiRefusal from '../../src/gemini-refusal.js';
import * as promptTemplates from '../../src/prompt-templates.js';
import { makeCtx } from './fake-ctx.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Load the DO source (verbatim technique from bridge-handshake.test.mjs) ──
const doSource = fs.readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8');

const doClassSrc = doSource
  .replace(/import[\s\S]*?from "[^"]+";/g, '')
  .replaceAll('export class ', 'class ')
  .replace('export default {', 'const entry = {');

const workerdCrypto = {
  randomUUID,
  getRandomValues: (arr) => globalThis.crypto.getRandomValues(arr),
  subtle: globalThis.crypto.subtle,
};

class MockSocket {
  constructor() {
    this.readyState = 1;
    this.accepted = false;
    this.sent = [];
    this.closed = null;
    this.listeners = new Map();
  }
  accept() { this.accepted = true; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  send(data) { this.sent.push(data); }
  close(code, reason) { this.readyState = 3; this.closed = { code, reason }; }
  dispatch(type, event) {
    for (const fn of this.listeners.get(type) || []) fn(event);
  }
}

class MockWebSocketPair {
  constructor() {
    this[0] = new MockSocket(); // client
    this[1] = new MockSocket(); // server (DO side)
  }
}

// Node's Response rejects status 101, so the DO must be loaded with a
// Response double that accepts the upgrade response.
class MockResponse {
  constructor(body = null, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = init.headers || {};
    this.webSocket = init.webSocket ?? null;
    this.ok = this.status >= 200 && this.status < 300;
  }
  async text() { return this.body == null ? '' : String(this.body); }
  async json() { return JSON.parse(await this.text()); }
}

function loadDO() {
  const context = {
    ...modelCatalog,
    ...emulator,
    ...pdfLib,
    ...liveness,
    ...geminiRefusal,
    ...promptTemplates,
    DurableObject: class {},
    crypto: workerdCrypto,
    Response: MockResponse,
    Request,
    URL,
    TextEncoder,
    TextDecoder,
    TextEncoderStream,
    TransformStream,
    ReadableStream,
    WebSocketPair: MockWebSocketPair,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => {},
  };
  return vm.runInNewContext(doClassSrc + '\n;({GeminiBridgeDO})', context).GeminiBridgeDO;
}

// ─── Harness ────────────────────────────────────────────────────────────────

export function createMockWorker(options = {}) {
  const BRIDGE_AUTH_TOKEN = options.BRIDGE_AUTH_TOKEN ?? 'mock-bridge-secret-0123456789abcdef';
  const CLIENT_API_KEY = options.CLIENT_API_KEY ?? 'mock-client-key-0123456789abcdef';
  const GeminiBridgeDO = loadDO();
  const bridge = new GeminiBridgeDO(makeCtx(), { BRIDGE_AUTH_TOKEN, CLIENT_API_KEY });

  let delayMs = options.delayMs ?? Number(process.env.TEST_MOCK_DELAY_MS ?? 0);

  /** Dispatch an HTTP request straight into the DO, honouring the configured delay. */
  async function fetch(path, init = {}) {
    if (delayMs > 0) await sleep(delayMs);
    const res = await bridge.fetch(new Request(`https://mock.bridge${path}`, init));
    if (delayMs > 0) await sleep(delayMs);
    return res;
  }

  /** Upgrade a WebSocket against the in-process DO. Returns { status, client, server }. */
  async function upgradeWebSocket(path) {
    const res = await fetch(path, {
      method: 'GET',
      headers: {
        'x-bridge-token': new URL(path, 'https://mock.bridge').searchParams.get('token') ?? '',
        Upgrade: 'websocket',
      },
    });
    const instanceId = new URL(path, 'https://mock.bridge').searchParams.get('instanceId');
    const server = instanceId ? bridge.activeConnections.get(instanceId)?.socket : null;
    return { status: res.status, webSocket: res.webSocket, server };
  }

  return {
    bridge,
    fetch,
    upgradeWebSocket,
    setDelay: (ms) => { delayMs = ms; },
    getDelay: () => delayMs,
    BRIDGE_AUTH_TOKEN,
    CLIENT_API_KEY,
    dispose: async () => {},
  };
}

// ─── Fake extension client ──────────────────────────────────────────────────
// Speaks just enough of protocol v3 to satisfy the DO: connect, announce
// SESSION_READY, then answer EXECUTE_REQUEST with a cumulative STREAM_CHUNK
// line followed by STREAM_DONE.

/** Canonical Google RPC wire line the worker's decoder understands. */
const rpcLine = (text) =>
  ")]}'\n" + JSON.stringify([['wrb.fr', 'gen_ids', JSON.stringify(
    [null, ['c_mock', 'r_mock'], null, null, [['choice0', [text]]]]
  )]]);

export async function connectFakeExtension(worker, {
  instanceId = null,
  scope = 'app',
  onExecute = null,
} = {}) {
  const id = instanceId ?? randomUUID();
  const upgrade = await worker.upgradeWebSocket(
    `/bridge?token=${encodeURIComponent(worker.BRIDGE_AUTH_TOKEN)}&client=background_sw&instanceId=${id}`
  );
  if (upgrade.status !== 101 || !upgrade.server) {
    throw new Error(`fake extension upgrade failed: HTTP ${upgrade.status}`);
  }
  const server = upgrade.server;
  const seen = [];

  const originalSend = server.send.bind(server);
  server.send = (data) => {
    originalSend(data);
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    seen.push(msg);
    if (msg.type === 'PREPARE_MODEL') {
      // Verify the mocked catalog mapping so the worker's prepare step passes.
      server.dispatch('message', {
        data: JSON.stringify({
          type: 'MODEL_READY',
          requestId: msg.requestId,
          model: msg.model,
          mappingRevision: 'rev_mock0001',
        }),
      });
      return;
    }
    if (msg.type === 'EXECUTE_REQUEST') {
      const reply = onExecute ? onExecute(msg) : { text: 'mock reply', delayMs: 0 };
      Promise.resolve(reply).then(async ({ text, delayMs: d = 0 }) => {
        if (d > 0) await sleep(d);
        server.dispatch('message', {
          data: JSON.stringify({ type: 'STREAM_CHUNK', requestId: msg.requestId, chunk: rpcLine(text) + '\n' }),
        });
        server.dispatch('message', {
          data: JSON.stringify({ type: 'STREAM_DONE', requestId: msg.requestId }),
        });
      });
    }
  };

  server.dispatch('message', {
    data: JSON.stringify({
      type: 'SESSION_READY',
      protocolVersion: 3,
      scope,
      tokens: { csrf: 'mock-csrf' },
    }),
  });
  server.dispatch('message', {
    data: JSON.stringify({
      type: 'MODELS_DISCOVERED',
      protocolVersion: 3,
      activeModel: '3.8 Flash',
      models: [{
        id: 'gemini-3.8-flash',
        name: '3.8 Flash',
        description: 'mock catalog entry',
        verification: 'verified',
        mapping_revision: 'rev_mock0001',
      }],
    }),
  });
  await sleep(20); // let the DO process SESSION_READY

  return { server, seen, close: () => server.close(1000, 'mock closed') };
}
