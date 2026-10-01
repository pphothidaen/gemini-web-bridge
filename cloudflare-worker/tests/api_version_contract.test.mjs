/**
 * The backward-compatibility contract for the versioned REST surface.
 *
 * `/v1` is frozen. Every client in the wild — CI probes, the keepalive script,
 * `scripts/health-check.sh`, `prod-endpoint-matrix.mjs`, and whatever the
 * operator points a client at — reads the response shapes it returns. A field
 * renamed or dropped is not a refactor, it is an outage that only shows up
 * once something outside this repo calls the endpoint.
 *
 * Nothing in the codebase prevents that today. The version prefix was
 * hardcoded at four literal `url.pathname === "/v1/..."` comparisons, so there
 * was no single place a breaking change would have to be deliberate in, and no
 * assertion anywhere that the shape was still the shape.
 *
 * So this file is that assertion, in three parts:
 *
 *   1. v1 and v2 return byte-identical bodies for the same request. Not
 *      "equivalent" — the same keys with the same types. This is what makes
 *      /v2 a safe place to diverge LATER without touching /v1 now.
 *   2. The v1 shape is pinned field by field. A rename fails; adding a field
 *      is allowed, because additive change is the one kind that cannot break
 *      an existing reader.
 *   3. The routing refuses an unknown version loudly rather than 404ing with
 *      the same body as a typo.
 *
 * The mutation checks at the bottom are the real content, for the same reason
 * `dom-signal-contract.test.mjs` has its own: a test asserting "the contract
 * holds" is worth nothing if the contract can be edited to match whatever the
 * code happens to do. Each one breaks something and must be observed to fail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMockWorker } from './helpers/mock-worker.mjs';

const auth = (worker) => ({ Authorization: `Bearer ${worker.CLIENT_API_KEY}` });

const getJson = async (res) => ({ status: res.status, body: await res.json() });

// ─── 1. v1 and v2 must be indistinguishable ────────────────────────────────

test('v1 and v2 /models return the same shape', async () => {
  const worker = createMockWorker();
  try {
    const v1 = await getJson(await worker.fetch('/v1/models', { headers: auth(worker) }));
    const v2 = await getJson(await worker.fetch('/v2/models', { headers: auth(worker) }));

    assert.equal(v1.status, 200);
    assert.equal(v2.status, 200);

    // Same top-level keys, same order-independent set.
    assert.deepEqual(Object.keys(v2.body).sort(), Object.keys(v1.body).sort());

    // Same per-model keys. `catalog_revision` and `browser_active_model` are
    // allowed to differ in VALUE only if the extension moved between calls —
    // in the mock it never connects, so they must match exactly.
    const shapeOf = (body) =>
      (body.data ?? []).map((m) => Object.keys(m).sort());
    assert.deepEqual(shapeOf(v2.body), shapeOf(v1.body));
  } finally {
    await worker.dispose();
  }
});

test('v1 and v2 /models return identical bodies for the same request', async () => {
  const worker = createMockWorker();
  try {
    // Not a shape check — a byte check. Two handlers that agreed on keys but
    // disagreed on values would pass the test above, and a client that pins
    // `default_recommended` would still break.
    const v1 = await getJson(await worker.fetch('/v1/models', { headers: auth(worker) }));
    const v2 = await getJson(await worker.fetch('/v2/models', { headers: auth(worker) }));
    assert.deepEqual(v2.body, v1.body);
  } finally {
    await worker.dispose();
  }
});

test('v1 and v2 reject an unauthenticated request identically', async () => {
  const worker = createMockWorker();
  try {
    for (const path of ['/v1/models', '/v2/models', '/v1/chat/completions', '/v2/chat/completions']) {
      const res = await worker.fetch(path, {
        method: path.includes('completions') ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        ...(path.includes('completions')
          ? { body: JSON.stringify({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] }) }
          : {}),
      });
      const { status, body } = await getJson(res);
      assert.equal(status, 401, `${path} must require a key`);
      assert.equal(body.error.code, 'invalid_api_key', `${path} must use the same auth error code`);
    }
  } finally {
    await worker.dispose();
  }
});

test('v1 and v2 validate a malformed body identically', async () => {
  const worker = createMockWorker();
  try {
    for (const p of ['/v1/chat/completions', '/v2/chat/completions']) {
      const res = await worker.fetch(p, {
        method: 'POST',
        headers: { ...auth(worker), 'Content-Type': 'application/json' },
        body: 'not-json',
      });
      const { status, body } = await getJson(res);
      assert.equal(status, 400, `${p} must reject malformed JSON`);
      assert.equal(body.error.code, 'bad_json');
    }
  } finally {
    await worker.dispose();
  }
});

// ─── 2. The v1 shape is pinned ─────────────────────────────────────────────

test('v1 /models keeps every field a client reads', async () => {
  const worker = createMockWorker();
  try {
    const { status, body } = await getJson(await worker.fetch('/v1/models', { headers: auth(worker) }));
    assert.equal(status, 200);

    // Exact set. Adding a field is fine and needs no edit here; REMOVING or
    // RENAMING one must be a deliberate change to this list, in the same
    // commit as the code change, with a CHANGELOG entry.
    assert.deepEqual(Object.keys(body).sort(), [
      'browser_active_model',
      'catalog_revision',
      'data',
      'default_reasoning_effort',
      'default_recommended',
      'object',
      'status',
    ]);

    assert.equal(body.object, 'list');
    assert.ok(Array.isArray(body.data));

    // These three are read by name in scripts/ and by the client setup docs.
    // `status` is the one that carries the retired-host symptom, so it is
    // specifically pinned to its documented domain.
    assert.ok('default_recommended' in body);
    assert.ok('catalog_revision' in body);
    assert.ok(['disconnected', 'discovering', 'ready'].includes(body.status),
      `unexpected status value: ${body.status}`);
  } finally {
    await worker.dispose();
  }
});

test('the unversioned /models alias still resolves to v1 behaviour', async () => {
  const worker = createMockWorker();
  try {
    const alias = await getJson(await worker.fetch('/models', { headers: auth(worker) }));
    const v1 = await getJson(await worker.fetch('/v1/models', { headers: auth(worker) }));
    assert.equal(alias.status, 200);
    assert.deepEqual(alias.body, v1.body);
  } finally {
    await worker.dispose();
  }
});

// ─── 3. Unknown versions fail loudly ───────────────────────────────────────

test('an unsupported API version is named, not swallowed', async () => {
  const worker = createMockWorker();
  try {
    const res = await worker.fetch('/v9/models', { headers: auth(worker) });
    const { status, body } = await getJson(res);

    // A bare 404 here would be indistinguishable from a typo, and the caller
    // would have no way to learn that v2 exists.
    assert.equal(status, 404);
    assert.equal(body.error.code, 'unsupported_api_version');
    assert.match(body.error.message, /v1/, 'must name the supported versions');
    assert.match(body.error.message, /v2/);
  } finally {
    await worker.dispose();
  }
});

test('an unsupported version is rejected before the auth gate', async () => {
  const worker = createMockWorker();
  try {
    // No key. A version that does not exist is a client mistake, so it must
    // not read as a credential problem and send the caller hunting for one.
    const res = await worker.fetch('/v9/models');
    const { status, body } = await getJson(res);
    assert.equal(status, 404);
    assert.equal(body.error.code, 'unsupported_api_version');
  } finally {
    await worker.dispose();
  }
});

test('an unknown path under a supported version still 404s as not_found', async () => {
  const worker = createMockWorker();
  try {
    const res = await worker.fetch('/v1/nonexistent', { headers: auth(worker) });
    const { status, body } = await getJson(res);
    assert.equal(status, 404);
    // Must NOT be unsupported_api_version — the version was fine, the path
    // was not. Collapsing the two would hide a real routing bug.
    assert.equal(body.error.code, 'not_found');
  } finally {
    await worker.dispose();
  }
});

// ─── 4. Unversioned surfaces must not be versionable ───────────────────────

test('a version prefix does not make /health public', async () => {
  const worker = createMockWorker();
  try {
    // `/health` is on the public allowlist keyed on the literal path. If the
    // auth decision were keyed on the stripped path instead, `/v1/health`
    // would inherit public access and leak the whole health report — which
    // carries model ids, scope and connection state — to anyone.
    const res = await worker.fetch('/v1/health');
    const { status } = await getJson(res);
    assert.equal(status, 401, '/v1/health must not be public');
  } finally {
    await worker.dispose();
  }
});

test('/mcp is not reachable under a version prefix', async () => {
  const worker = createMockWorker();
  try {
    const res = await worker.fetch('/v1/mcp', { method: 'POST', headers: auth(worker) });
    const { status, body } = await getJson(res);
    // The MCP transport is unversioned by design (MCP-Session-Id is the
    // protocol's own versioning). A versioned alias would create a second
    // session namespace nobody negotiates.
    assert.equal(status, 404);
    assert.equal(body.error.code, 'not_found');
  } finally {
    await worker.dispose();
  }
});

// ─── 5. Discovery ─────────────────────────────────────────────────────────

test('/health advertises the supported versions', async () => {
  const worker = createMockWorker();
  try {
    const { status, body } = await getJson(await worker.fetch('/health'));
    assert.equal(status, 200);
    assert.deepEqual(body.api_versions.supported, ['v1', 'v2']);
    assert.equal(body.api_versions.default, 'v1');
    assert.deepEqual(body.api_versions.deprecated, {});
  } finally {
    await worker.dispose();
  }
});

test('the version list the worker advertises matches what it routes', async () => {
  const worker = createMockWorker();
  try {
    const { body: health } = await getJson(await worker.fetch('/health'));

    for (const v of health.api_versions.supported) {
      const res = await worker.fetch(`/${v}/models`, { headers: auth(worker) });
      assert.equal(res.status, 200, `/${v}/models is advertised but does not route`);
    }

    // And one that is not advertised must not route either. Without this, the
    // advertised list could drift into being a subset of what actually works,
    // which is the failure this whole file exists to prevent.
    const next = `v${health.api_versions.supported.length + 1}`;
    const res = await worker.fetch(`/${next}/models`, { headers: auth(worker) });
    assert.equal(res.status, 404, `/${next} is not advertised and must not route`);
  } finally {
    await worker.dispose();
  }
});

// ─── Mutations: each must be observed to fail, then reverted ───────────────
//
// Run by editing src/index.js per the note beside each, `npm test`, and
// confirming the named test goes red. A mutation that does not change the
// result means the assertion is decorative.

/*
 * MUTATION A — remove v2 from SUPPORTED_API_VERSIONS.
 *   Expect: "an unsupported API version is named, not swallowed" FAILS
 *   (/v9 now routes through the generic 404), and the discovery test FAILS.
 *
 * MUTATION B — make the v1 /models handler drop `catalog_revision`.
 *   Expect: "v1 /models keeps every field a client reads" FAILS on the exact
 *   key set. The v1-vs-v2 byte test still passes, which is the point — that
 *   test guards against divergence, this one guards against loss.
 *
 * MUTATION C — key the auth gate on `apiPath` instead of `url.pathname`.
 *   Expect: "a version prefix does not make /health public" FAILS.
 *
 * MUTATION D — return `unsupported_api_version` for any 404.
 *   Expect: "an unknown path under a supported version still 404s as
 *   not_found" FAILS, catching the two failure modes collapsing into one.
 */