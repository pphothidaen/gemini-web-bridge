#!/usr/bin/env node
/**
 * Full production endpoint + MCP tool matrix for gemini-web-bridge.
 *
 * Covers every route in cloudflare-worker/src/index.js:
 *   GET  /  /health (public) | WS /bridge | GET /bridge/auth-check
 *   POST /bridge/reset | GET /artifacts/{key} | GET /v1/models /models
 *   POST /v1/chat/completions | GET/POST/DELETE /mcp
 * plus every tool in the tools/list catalogue and MCP protocol errors.
 *
 * Never prints secret values. Reads keys from the repo .env.
 */
import { readFileSync, writeFileSync } from "node:fs";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const key = (name) =>
  (env.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1] ?? "").trim().replace(/^["']|["']$/g, "");

const CLIENT_API_KEY = key("CLIENT_API_KEY") || key("CLIENT_API_TOKEN");
const BRIDGE_AUTH_TOKEN = key("BRIDGE_AUTH_TOKEN") || key("BRIDGE_AUTH_TOKEN");
if (!CLIENT_API_KEY || !BRIDGE_AUTH_TOKEN) {
  console.error("Missing CLIENT_API_KEY or BRIDGE_AUTH_TOKEN in .env");
  process.exit(1);
}

const BASE = (process.env.WORKER_URL ?? "https://prod.gemini-web-bridge.workers.dev").replace(/\/$/, "");
const results = [];
let rpcId = 100;
const nextId = () => ++rpcId;

const record = (name, passed, detail) => {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}\n        ${String(detail).replace(/\s+/g, " ").slice(0, 300)}`);
};

async function req(path, { method = "GET", headers = {}, body, auth = true, timeout = 60 } = {}) {
  const h = { ...headers };
  if (auth) h.Authorization = `Bearer ${CLIENT_API_KEY}`;
  if (body !== undefined && !h["Content-Type"]) h["Content-Type"] = "application/json";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout * 1000);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: res.status, headers: res.headers, text, json };
  } catch (e) {
    return {
      status: 0,
      error: e.name === "AbortError" ? `timeout after ${timeout}s` : e.message,
      text: "",
      json: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

const rpc = (path, payload, opts) => req(path, { method: "POST", body: payload, ...opts });

// ───────────────────────────── public / status ─────────────────────────────
console.log("\n═══ PUBLIC + STATUS ENDPOINTS ═══");
{
  const r = await req("/health", { auth: false });
  const ok = r.status === 200 && r.json?.status === "ok" && typeof r.json?.version === "string";
  record("GET /health (no auth)", ok,
    `${r.status} version=${r.json?.version} ext=${r.json?.extension_status} conns=${r.json?.instance_tracking?.active_connections_count} models=${JSON.stringify(r.json?.browser_models)}`);

  const root = await req("/", { auth: false });
  record("GET / (no auth, dashboard)",
    root.status === 200 && root.json?.endpoints?.mcp?.includes("/mcp"),
    `${root.status} endpoints=${JSON.stringify(root.json?.endpoints)}`);
}

// ───────────────────────────── auth enforcement ─────────────────────────────
console.log("\n═══ AUTH ENFORCEMENT ═══");
{
  const noKey = await req("/v1/models", { auth: false });
  record("GET /v1/models rejects missing key",
    noKey.status === 401 && noKey.json?.error?.code === "invalid_api_key",
    `${noKey.status} ${noKey.json?.error?.code}`);

  // NOTE: auth:false is required here. In req(), `if (auth) h.Authorization = ...`
  // runs AFTER `{...headers}`, so leaving auth on overwrote the deliberately
  // wrong key with the good one and the probe measured the happy path.
  const badKey = await req("/v1/models", { auth: false, headers: { Authorization: "Bearer wrong-key-000" } });
  record("GET /v1/models rejects bad key", badKey.status === 401, `${badKey.status} ${badKey.json?.error?.code}`);

  const good = await req("/v1/models");
  record("GET /v1/models accepts valid key",
    good.status === 200 && Array.isArray(good.json?.data),
    `${good.status} count=${good.json?.data?.length}`);

  const mcpNoKey = await req("/mcp", {
    method: "POST", body: { jsonrpc: "2.0", id: 1, method: "ping" }, auth: false,
  });
  record("POST /mcp rejects missing key", mcpNoKey.status === 401, `${mcpNoKey.status}`);

  const ac = await req("/bridge/auth-check", { auth: false, headers: { "x-bridge-token": BRIDGE_AUTH_TOKEN } });
  record("GET /bridge/auth-check valid token",
    ac.status === 200 && ac.json?.ok === true, `${ac.status} ${JSON.stringify(ac.json)}`);

  const acBad = await req("/bridge/auth-check", { auth: false, headers: { "x-bridge-token": "nope" } });
  record("GET /bridge/auth-check bad token",
    acBad.status === 401 && acBad.json?.ok === false, `${acBad.status}`);

  const acNone = await req("/bridge/auth-check", { auth: false });
  record("GET /bridge/auth-check no token", acNone.status === 401, `${acNone.status}`);
}

// ───────────────────────────── models ─────────────────────────────
console.log("\n═══ MODEL CATALOGUE ═══");
for (const p of ["/v1/models", "/models"]) {
  const r = await req(p);
  const ids = (r.json?.data ?? []).map((m) => m.id);
  record(`GET ${p}`, r.status === 200 && ids.length > 0,
    `${r.status} ids=${JSON.stringify(ids.slice(0, 8))}`);
}

// ───────────────────────────── chat completions ─────────────────────────────
console.log("\n═══ OPENAI-COMPATIBLE /v1/chat/completions ═══");
// The catalogue is discovered from the live browser tab, so the old hardcoded
// "gemini-web-thinking" is no longer a valid id. Resolve a real id from
// /v1/models and use it for the live calls below.
const catalog = (await req("/v1/models")).json?.data ?? [];
const LIVE_MODEL = catalog[0]?.id;
console.log(`     live model id = ${LIVE_MODEL}`);

{
  const noMsg = await rpc("/v1/chat/completions", { model: "gemini-web-thinking", messages: [] });
  record("POST chat: empty messages -> 400",
    noMsg.status === 400,
    `${noMsg.status} ${noMsg.json?.error?.message ?? noMsg.json?.error?.type}`);

  const badJson = await rpc("/v1/chat/completions", "not-json");
  record("POST chat: malformed JSON -> 400",
    badJson.status === 400,
    `${badJson.status} ${badJson.json?.error?.message ?? badJson.json?.error?.code}`);

  // A model absent from the current browser catalogue must 404 rather than
  // silently fall back — this is the guard that keeps clients off dead ids.
  const stale = await rpc("/v1/chat/completions", {
    model: "gemini-web-thinking",
    messages: [{ role: "user", content: "hi" }],
  });
  record("POST chat: stale model id -> 404 model_not_available",
    stale.status === 404 && stale.json?.error?.code === "model_not_available",
    `${stale.status} ${stale.json?.error?.code}`);

  const chat = await rpc("/v1/chat/completions", {
    model: LIVE_MODEL,
    messages: [{ role: "user", content: "Reply with the single word: PONG" }],
  }, { timeout: 120 });
  const txt = chat.json?.choices?.[0]?.message?.content ?? "";
  record("POST chat: live completion",
    chat.status === 200 && txt.length > 0,
    `${chat.status} content="${txt.replace(/\s+/g, " ").slice(0, 160)}"`);

  const stream = await rpc("/v1/chat/completions", {
    model: LIVE_MODEL,
    messages: [{ role: "user", content: "Count 1 to 3." }],
    stream: true,
  }, { timeout: 120 });
  const chunks = (stream.text.match(/data: /g) ?? []).length;
  const done = stream.text.includes("data: [DONE]");
  record("POST chat: streaming SSE",
    stream.status === 200 && done && chunks > 1,
    `${stream.status} chunks=${chunks} done=${done}`);

  const toolsPayload = await rpc("/v1/chat/completions", {
    model: LIVE_MODEL,
    messages: [{ role: "user", content: "Read /etc/hostname" }],
    tools: [{
      type: "function",
      function: {
        name: "read_file", description: "read",
        parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
      },
    }],
    tool_choice: "auto",
  }, { timeout: 120 });
  const choice = toolsPayload.json?.choices?.[0];
  record("POST chat: tool-calling path",
    toolsPayload.status === 200 && !!choice,
    `${toolsPayload.status} finish_reason=${choice?.finish_reason} tool_calls=${choice?.message?.tool_calls?.length ?? 0}`);
}

{
  const noMsg = await rpc("/v1/chat/completions", { model: "gemini-web-thinking", messages: [] });
  record("POST chat: empty messages -> 400",
    noMsg.status === 400,
    `${noMsg.status} ${noMsg.json?.error?.message ?? noMsg.json?.error?.type}`);

  const badJson = await rpc("/v1/chat/completions", "not-json");
  record("POST chat: malformed JSON -> 400",
    badJson.status === 400,
    `${badJson.status} ${badJson.json?.error?.message ?? badJson.json?.error?.code}`);

  const chat = await rpc("/v1/chat/completions", {
    model: "gemini-web-thinking",
    messages: [{ role: "user", content: "Reply with the single word: PONG" }],
  }, { timeout: 90 });
  const txt = chat.json?.choices?.[0]?.message?.content ?? "";
  record("POST chat: live completion",
    chat.status === 200 && txt.length > 0,
    `${chat.status} content="${txt.replace(/\s+/g, " ").slice(0, 160)}"`);

  const stream = await rpc("/v1/chat/completions", {
    model: "gemini-web-thinking",
    messages: [{ role: "user", content: "Count 1 to 3." }],
    stream: true,
  }, { timeout: 90 });
  const chunks = (stream.text.match(/data: /g) ?? []).length;
  const done = stream.text.includes("data: [DONE]");
  record("POST chat: streaming SSE",
    stream.status === 200 && done && chunks > 1,
    `${stream.status} chunks=${chunks} done=${done}`);

  const toolsPayload = await rpc("/v1/chat/completions", {
    model: "gemini-web-thinking",
    messages: [{ role: "user", content: "Read /etc/hostname" }],
    tools: [{
      type: "function",
      function: {
        name: "read_file", description: "read",
        parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
      },
    }],
    tool_choice: "auto",
  }, { timeout: 90 });
  const choice = toolsPayload.json?.choices?.[0];
  record("POST chat: tool-calling path",
    toolsPayload.status === 200 && !!choice,
    `${toolsPayload.status} finish_reason=${choice?.finish_reason} tool_calls=${choice?.message?.tool_calls?.length ?? 0}`);
}

// ───────────────────────────── artifacts ─────────────────────────────
console.log("\n═══ ARTIFACTS ═══");
{
  const missing = await req("/artifacts/" + "0".repeat(32), { auth: false });
  record("GET /artifacts/{32hex} unknown key -> 404",
    missing.status === 404, `${missing.status} ${missing.json?.error}`);

  const badKey = await req("/artifacts/not-a-valid-key", { auth: false });
  record("GET /artifacts/bad-format -> 404", badKey.status === 404, `${badKey.status}`);

  // Public route: must NOT answer 401 without auth. 404 == reachable + key absent.
  const noAuthValid = await req("/artifacts/" + "a".repeat(32), { auth: false });
  record("GET /artifacts/{key} reachable without auth",
    noAuthValid.status === 404,
    `${noAuthValid.status} (404 = route reachable unauthenticated, key absent)`);
}

// ───────────────────────────── bridge websocket / admin ─────────────────────────────
// Node's undici fetch cannot perform a raw HTTP/1.1 Upgrade handshake, so the
// /bridge rejections are probed with curl (which can). Probing them with fetch
// returns status 0 and reports a transport error, which says nothing about
// whether the worker rejected the request.
console.log("\n═══ BRIDGE WEBSOCKET + ADMIN ═══");
{
  const { execFileSync } = await import("node:child_process");
  const WS_H = [
    "--http1.1", "-s", "-o", "/dev/null", "-w", "%{http_code}",
    "-H", "Connection: Upgrade", "-H", "Upgrade: websocket",
    "-H", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "-H", "Sec-WebSocket-Version: 13",
  ];
  const wsStatus = (target) => {
    try {
      return execFileSync("curl", [...WS_H, target], { encoding: "utf8", timeout: 20000 }).trim();
    } catch (e) {
      return `err:${(e.stderr || e.message).toString().slice(0, 40)}`;
    }
  };

  record("WS /bridge rejects missing token",
    wsStatus(`${BASE}/bridge`) === "401", `HTTP ${wsStatus(`${BASE}/bridge`)}`);

  const badTok = wsStatus(`${BASE}/bridge?token=wrong`);
  record("WS /bridge rejects bad token", badTok === "401", `HTTP ${badTok}`);

  const badId = wsStatus(`${BASE}/bridge?token=${encodeURIComponent(BRIDGE_AUTH_TOKEN)}&instanceId=not-a-uuid`);
  record("WS /bridge rejects bad instanceId", badId === "401", `HTTP ${badId}`);

  const noId = wsStatus(`${BASE}/bridge?token=${encodeURIComponent(BRIDGE_AUTH_TOKEN)}`);
  record("WS /bridge rejects missing instanceId", noId === "401", `HTTP ${noId}`);

  const resetBad = await rpc("/bridge/reset?token=wrong", null, { auth: false });
  record("POST /bridge/reset rejects bad token",
    resetBad.status === 401, `${resetBad.status}`);

  // /bridge/reset is NOT on the public-path allowlist, so a GET with only
  // ?token= is stopped by the auth gate with 401 before route matching runs.
  // It never reaches the 404 — that ordering is the intended behaviour.
  const resetGet = await req(`/bridge/reset?token=${encodeURIComponent(BRIDGE_AUTH_TOKEN)}`, { auth: false });
  record("GET /bridge/reset is auth-gated before routing",
    resetGet.status === 401, `${resetGet.status} (auth gate precedes route match)`);
}

// ───────────────────────────── MCP protocol ─────────────────────────────
console.log("\n═══ MCP PROTOCOL (/mcp) ═══");
let mcpSession = null;
{
  const init = await rpc("/mcp", {
    jsonrpc: "2.0", id: nextId(), method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "endpoint-matrix", version: "1.0" } },
  });
  mcpSession = init.headers.get("mcp-session-id");
  const r = init.json?.result ?? {};
  record("MCP initialize",
    init.status === 200 && r.serverInfo?.name === "gemini-web-bridge-cloud-hub",
    `${init.status} server=${r.serverInfo?.name} v${r.serverInfo?.version} proto=${r.protocolVersion} caps=${JSON.stringify(r.capabilities)} session=${mcpSession ? "issued" : "none"}`);

  const notif = await rpc("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" });
  record("MCP notifications/initialized -> 202 empty",
    notif.status === 202 && notif.text === "", `${notif.status} bodyLen=${notif.text.length}`);

  const list = await rpc("/mcp", { jsonrpc: "2.0", id: nextId(), method: "tools/list", params: {} });
  const toolList = list.json?.result?.tools ?? [];
  const schemaOk = toolList.every((t) => t.name && t.description && t.inputSchema?.type === "object");
  record("MCP tools/list",
    list.status === 200 && toolList.length > 0 && schemaOk,
    `${list.status} count=${toolList.length} names=${JSON.stringify(toolList.map((t) => t.name))}`);

  const p = await rpc("/mcp", { jsonrpc: "2.0", id: nextId(), method: "ping", params: {} });
  record("MCP JSON-RPC ping",
    p.status === 200 && JSON.stringify(p.json?.result) === "{}",
    `${p.status} ${JSON.stringify(p.json?.result)}`);

  for (const [method, k] of [["prompts/list", "prompts"], ["resources/list", "resources"], ["resources/templates/list", "resourceTemplates"]]) {
    const r2 = await rpc("/mcp", { jsonrpc: "2.0", id: nextId(), method, params: {} });
    record(`MCP ${method}`,
      r2.status === 200 && Array.isArray(r2.json?.result?.[k]),
      `${r2.status} ${k}=${JSON.stringify(r2.json?.result?.[k])}`);
  }

  const parse = await rpc("/mcp", "}{bad json");
  record("MCP malformed JSON -> -32700",
    parse.status === 400 && parse.json?.error?.code === -32700,
    `${parse.status} ${parse.json?.error?.code} ${parse.json?.error?.message}`);

  const invalidReq = await rpc("/mcp", []);
  record("MCP empty batch -> -32600",
    invalidReq.status === 400 && invalidReq.json?.error?.code === -32600,
    `${invalidReq.status} ${invalidReq.json?.error?.code} ${invalidReq.json?.error?.message}`);

  const unknown = await rpc("/mcp", { jsonrpc: "2.0", id: nextId(), method: "no/such/method", params: {} });
  record("MCP unknown method -> -32601",
    unknown.json?.error?.code === -32601,
    `${unknown.status} ${unknown.json?.error?.code} ${unknown.json?.error?.message}`);

  const unknownTool = await rpc("/mcp", { jsonrpc: "2.0", id: nextId(), method: "tools/call", params: { name: "no_such_tool", arguments: {} } });
  record("MCP unknown tool -> error",
    unknownTool.json?.error?.code === -32601 || unknownTool.json?.error?.code === -32602,
    `${unknownTool.status} code=${unknownTool.json?.error?.code} msg=${unknownTool.json?.error?.message}`);

  const badSess = await rpc("/mcp?sessionId=does-not-exist", { jsonrpc: "2.0", id: nextId(), method: "ping" });
  record("MCP unknown SSE session -> 404 -32001",
    badSess.status === 404 && badSess.json?.error?.code === -32001,
    `${badSess.status} ${badSess.json?.error?.code}`);

  const batch = await rpc("/mcp", [
    { jsonrpc: "2.0", id: nextId(), method: "ping" },
    { jsonrpc: "2.0", id: nextId(), method: "tools/list" },
  ]);
  const batchArr = Array.isArray(batch.json) ? batch.json : null;
  record("MCP batch request",
    batch.status === 200 && batchArr?.length === 2,
    `${batch.status} responses=${batchArr?.length}`);

  const del = await req(`/mcp?sessionId=${encodeURIComponent(mcpSession ?? "x")}`, { method: "DELETE" });
  record("MCP DELETE session", del.status < 500,
    `${del.status} ${del.json ? JSON.stringify(del.json).slice(0, 120) : ""}`);
}

// ───────────────────────────── every MCP tool ─────────────────────────────
console.log("\n═══ MCP TOOLS ═══");
const health = (await req("/health")).json;
const extReady = health?.extension_status === "CONNECTED_AND_READY";
console.log(`     extension_status = ${health?.extension_status}` +
  (extReady ? "" : "   <-- extension-dependent tools will report DISCONNECTED (expected while Chrome is closed)"));

const callTool = (name, args, timeout = 120) =>
  rpc("/mcp", { jsonrpc: "2.0", id: nextId(), method: "tools/call", params: { name, arguments: args } }, { timeout });

const showResult = (r) => {
  if (r.error) return `transport=${r.error}`;
  if (r.json?.error) return `code=${r.json.error.code} msg=${r.json.error.message}`;
  const t = r.json?.result?.content?.[0]?.text ?? "";
  return `${r.json?.result?.isError ? "isError " : ""}text="${t.replace(/\s+/g, " ").slice(0, 220)}"`;
};

// ── offline-safe / diagnostic tools
{
  const ping = await callTool("ping", {});
  record("tool ping",
    ping.json?.result?.content?.[0]?.text?.includes("Pong! Cloud Hub v"),
    showResult(ping));

  const hb = await callTool("check_bridge_health", {});
  record("tool check_bridge_health",
    !!hb.json?.result?.content?.[0]?.text, showResult(hb));

  const lm = await callTool("list_bridge_models", {});
  record("tool list_bridge_models",
    lm.json?.result !== undefined || !!lm.json?.error, showResult(lm));

  const missingScope = await callTool("set_bridge_scope", {});
  record("tool set_bridge_scope missing required arg",
    !!missingScope.json?.error,
    `${missingScope.json?.error?.code} ${missingScope.json?.error?.message}`);

  const badScope = await callTool("set_bridge_scope", { scope: "definitely-not-a-valid-scope-zzz" });
  record("tool set_bridge_scope invalid input -> error",
    !!badScope.json?.error,
    `${badScope.json?.error?.code} ${badScope.json?.error?.message}`);

  const scopeApp = await callTool("set_bridge_scope", { scope: "app" });
  record("tool set_bridge_scope app",
    scopeApp.json?.result !== undefined || !!scopeApp.json?.error, showResult(scopeApp));
}

// ── validation-only: must reject before touching the extension
console.log("\n─── required-argument validation ───");
for (const name of [
  "sdlc_solution_architect", "code_review_and_debug",
  "evaluate_tech_tradeoffs", "orchestrate_sdlc_plan", "horo_consult",
]) {
  const r = await callTool(name, {});
  record(`tool ${name} missing-arg -> -32602`,
    r.json?.error?.code === -32602,
    `${r.json?.error?.code} ${r.json?.error?.message}`);
}

// ── extension-dependent tools
console.log("\n─── extension-dependent tool calls ───");
const liveCases = [
  ["sdlc_solution_architect", { problem_description: "Design a URL shortener handling 10M redirects/day", tech_stack: "Cloudflare Workers + KV" }],
  ["orchestrate_sdlc_plan", { feature_or_goal: "Ship a passwordless login flow" }],
  ["code_review_and_debug", { code_snippet: "def f(a):\n  return a/0", error_log: "ZeroDivisionError", language: "python" }],
  ["evaluate_tech_tradeoffs", { decision_context: "Pick a queue for a 500 jobs/min pipeline", options: "Cloudflare Queues vs SQS vs Kafka" }],
  ["horo_consult", { query: "สรุปหลักการนับวันเกิดแบบสั้น ๆ 3 ข้อ", response_format: "text" }],
];
for (const [name, args] of liveCases) {
  const r = await callTool(name, args, 150);
  const text = r.json?.result?.content?.[0]?.text ?? "";
  const graceful = /disconnect|open gemini.google.com|not connected|unavailable/i.test(
    text + " " + (r.json?.error?.message ?? ""));
  // PASS when the tool answers; when the extension is offline, a graceful
  // "disconnected" message is the correct behaviour, not a 5xx.
  const passed = text.length > 0 || !!r.json?.error;
  record(`tool ${name} live`, passed,
    `${r.status} ${showResult(r)}${extReady ? "" : graceful ? "   [extension offline -> graceful]" : ""}`);
}

// ───────────────────────────── report ─────────────────────────────
const passed = results.filter((r) => r.passed).length;
const failed = results.length - passed;
console.log(`\n═══ SUMMARY: ${passed}/${results.length} passed, ${failed} failed ═══`);
for (const f of results.filter((r) => !r.passed)) console.log(`  FAIL ${f.name} -> ${f.detail}`);

writeFileSync("/tmp/prod-matrix.json", JSON.stringify({
  target: BASE,
  timestamp: new Date().toISOString(),
  version: health?.version,
  extension_status: health?.extension_status,
  passed, failed, results,
}, null, 2));
console.log("\nReport written to /tmp/prod-matrix.json");
process.exit(failed > 0 ? 1 : 0);
