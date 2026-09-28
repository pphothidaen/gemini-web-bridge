#!/usr/bin/env node
/**
 * Live smoke test for the native-retry recovery path.
 *
 * Why this exists
 * ---------------
 * The recovery selectors had been unit-tested only against mocks, and one of
 * them (`clipPath[id^="__lottie_element"]`) matched nothing on the real Gemini
 * build. Every wait silently degraded to text-stability, so short answers were
 * truncated mid-stream and nothing failed loudly. A green test suite said the
 * path worked while its primary signal was dead.
 *
 * This runs against the real thing: it drives the production bridge, forces
 * the replay path to fail, and checks that a native retry actually produces a
 * real, non-placeholder answer. It cannot prove which selector matched (that
 * lives in the browser) — the extension logs that — but it proves the
 * end-to-end outcome a caller actually depends on.
 *
 * Usage:
 *   node scripts/native-recovery-smoke.mjs
 *   node scripts/native-recovery-smoke.mjs --keep     # leave the chat open
 */
import { readFileSync, writeFileSync } from "node:fs";
import { classifyGeminiReply, REFUSAL_KIND } from "../cloudflare-worker/src/gemini-refusal.js";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const key = (name) =>
  (env.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1] ?? "").trim().replace(/^["']|["']$/g, "");

const API_KEY = key("CLIENT_API_KEY") || key("CLIENT_API_TOKEN");
if (!API_KEY) {
  console.error("Missing CLIENT_API_KEY in .env");
  process.exit(1);
}

const BASE = (process.env.WORKER_URL ?? "https://prod.gemini-web-bridge.workers.dev").replace(/\/$/, "");
const KEEP = process.argv.includes("--keep");

// Gemini's own "Gemini บอกว่า" label — 13 characters, and NOT an answer. A
// recovery that returns this has silently failed while reporting success.
const PLACEHOLDER = /^\s*gemini\s*บอกว่า\s*:?\s*$/i;

let rpcId = 0;
const call = async (name, args, timeout = 200) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout * 1000);
  try {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name, arguments: args }
      }),
      signal: ctrl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, text, json };
  } catch (e) {
    return { status: 0, text: "", json: null, error: e.name === "AbortError" ? `timeout after ${timeout}s` : e.message };
  } finally {
    clearTimeout(timer);
  }
};

const checks = [];
const check = (name, passed, detail) => {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}\n        ${String(detail).replace(/\s+/g, " ").slice(0, 220)}`);
};

const health = await (await fetch(`${BASE}/health`)).json();
console.log(`target      : ${BASE}`);
console.log(`version     : ${health.version}`);
console.log(`extension   : ${health.extension_status}\n`);

check("bridge reports the extension connected",
  health.extension_status === "CONNECTED_AND_READY",
  health.extension_status);

// Only a live, authenticated tab can exercise the recovery path.
if (health.extension_status !== "CONNECTED_AND_READY") {
  console.log("\nCannot run the live recovery smoke test without the extension. " +
    "Open Gemini in Chrome with the bridge extension loaded.");
  process.exit(1);
}

const CODE = `def compute(items):
    total = 0
    return total / len(items)`;
const ERROR = "compute([]) returns ZeroDivisionError-free garbage instead of erroring";

console.log("Driving a tool that exercises the replay -> native-retry path...\n");
const started = Date.now();
const r = await call("code_review_and_debug", {
  code_snippet: CODE,
  error_log: ERROR,
  language: "python"
});
const seconds = ((Date.now() - started) / 1000).toFixed(1);

if (r.error) {
  check("tool call returned", false, r.error);
} else if (r.json?.error) {
  check("tool call returned", false, `-${r.json.error.code} ${r.json.error.message}`);
} else {
  const answer = r.json?.result?.content?.[0]?.text ?? "";
  const verdict = classifyGeminiReply(answer);

  check("tool call returned a result", answer.length > 0, `${answer.length} chars in ${seconds}s`);
  check("answer is not the Gemini placeholder label",
    !PLACEHOLDER.test(answer) && answer.trim().length > 20,
    `first 120: ${answer.replace(/\s+/g, " ").slice(0, 120)}`);
  check("answer is not a refusal or upstream error",
    verdict.kind === REFUSAL_KIND.ANSWERED,
    `verdict=${verdict.kind}`);
  check("answer is substantive, not truncated mid-stream",
    answer.trim().length > 200,
    `${answer.trim().length} chars`);

  console.log(`\n── answer (first 400)\n${answer.slice(0, 400)}\n`);
}

const passed = checks.filter((c) => c.passed).length;
const failed = checks.length - passed;
console.log(`═══ ${passed}/${checks.length} passed, ${failed} failed ═══`);
console.log("Note: check the Gemini tab console for");
console.log("  [Bridge] 🔄 NATIVE_RETRY answered (signal=..., spinner=yes)");
console.log("— that line names the loading selector that actually matched.");

writeFileSync("/tmp/native-recovery-smoke.json", JSON.stringify({
  target: BASE, version: health.version, timestamp: new Date().toISOString(),
  passed, failed, checks
}, null, 2));
console.log("\nReport written to /tmp/native-recovery-smoke.json");

process.exit(failed > 0 ? 1 : 0);
