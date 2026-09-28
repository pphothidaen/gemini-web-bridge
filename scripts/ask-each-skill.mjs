#!/usr/bin/env node
/**
 * Ask one real question through every MCP tool (skill) on production.
 *
 * Unlike prod-endpoint-matrix.mjs (which proves routes and the argument
 * contract), this actually sends a question to Gemini through each tool and
 * reports the answer it got back, so a silent upstream failure (logged-out
 * browser session, dead model mapping) cannot hide behind a 200.
 *
 * Usage:  node scripts/ask-each-skill.mjs
 *         node scripts/ask-each-skill.mjs --tools=ping,horo_consult
 */
import { readFileSync, writeFileSync } from "node:fs";
import { classifyGeminiReply, isRetryWorthwhile, REFUSAL_KIND } from "../cloudflare-worker/src/gemini-refusal.js";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const key = (name) =>
  (env.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1] ?? "").trim().replace(/^["']|["']$/g, "");

const API_KEY = key("CLIENT_API_KEY") || key("CLIENT_API_TOKEN");
if (!API_KEY) {
  console.error("Missing CLIENT_API_KEY in .env");
  process.exit(1);
}

const BASE = (process.env.WORKER_URL ?? "https://prod.gemini-web-bridge.workers.dev").replace(/\/$/, "");
const only = (process.argv.find((a) => a.startsWith("--tools=")) ?? "").split("=")[1];
const onlySet = only ? new Set(only.split(",").map((s) => s.trim()).filter(Boolean)) : null;

// Sequential by default. The DO serialises browser generations behind
// `requestBusy`, so overlapping calls only queue into the 60s idle timeout
// and produce phantom "no response chunk" failures that look like bugs.
const noDelay = process.argv.includes("--no-delay");
const delayMs = Number((process.argv.find((a) => a.startsWith("--delay=")) ?? "").split("=")[1]) || 5000;

let rpcId = 0;
const call = async (name, args, timeout = 180) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout * 1000);
  try {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      signal: ctrl.signal,
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

// One genuine question per skill, in the language the tool is documented for.
const SKILLS = [
  { name: "ping", args: {},
    q: "สถานะของระบบ Bridge ตอนนี้เป็นอย่างไร" },
  { name: "check_bridge_health", args: {},
    q: "Extension เชื่อมต่ออยู่หรือไม่ และมี error สะสมกี่ครั้ง" },
  { name: "list_bridge_models", args: {},
    q: "ตอนนี้มีโมเดลอะไรให้ใช้บ้างในเบราว์เซอร์" },
  { name: "set_bridge_scope", args: { scope: "app" },
    q: "สลับขอบเขตการสนทนากลับไปเป็นแชทปกติ (app)" },
  { name: "sdlc_solution_architect", args: {
      problem_description: "ออกแบบระบบย่อ URL ที่รองรับ redirect 10 ล้านครั้งต่อวัน",
      tech_stack: "Cloudflare Workers + KV",
      constraints: "งบประมาณจำกัด, latency ต้องต่ำกว่า 50ms",
    },
    q: "ออกแบบสถาปัตยกรรมระบบย่อ URL" },
  { name: "orchestrate_sdlc_plan", args: {
      feature_or_goal: "เพิ่มระบบล็อกอินแบบไม่ใช้รหัสผ่าน (passwordless login)",
    },
    q: "วางแผน SDLC ของฟีเจอร์ passwordless login" },
  { name: "code_review_and_debug", args: {
      code_snippet: "function average(list) {\n  let sum = 0;\n  return sum / list.length;\n}",
      error_log: "average([]) คืน NaN แทนที่จะ error",
      language: "javascript",
    },
    q: "ตรวจสอบโค้ดและหาสาเหตุของบั๊ก" },
  { name: "evaluate_tech_tradeoffs", args: {
      decision_context: "เลือก message queue สำหรับ pipeline ที่ประมวลผลงาน 500 งานต่อนาที",
      options: "Cloudflare Queues vs Amazon SQS vs Apache Kafka",
    },
    q: "เปรียบเทียบข้อดีข้อเสียของ message queue แต่ละตัว" },
  { name: "horo_consult", args: {
      query: "สรุปหลักการนับวันเกิดแบบสั้น ๆ 3 ข้อสำหรับมือใหม่",
      response_format: "text",
    },
    q: "ปรึกษาด้านโหราศาสตร์จีน (BaZi)" },
];

const results = [];
const health = await (await fetch(`${BASE}/health`)).json();
console.log(`target      : ${BASE}`);
console.log(`version     : ${health.version}`);
console.log(`extension   : ${health.extension_status}`);
console.log(`active model: ${health.browser_models?.active_model}`);
console.log(`scope       : ${health.current_scope}\n`);

for (const skill of SKILLS) {
  if (onlySet && !onlySet.has(skill.name)) continue;
  console.log(`── ${skill.name}`);
  console.log(`   คำถาม: ${skill.q}`);

  const started = Date.now();
  const r = await call(skill.name, skill.args);
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  if (r.error) {
    console.log(`   ❌ transport: ${r.error}\n`);
    results.push({ skill: skill.name, question: skill.q, ok: false, verdict: "transport_fail",
      retryable: false, detail: r.error, seconds: secs });
    continue;
  }

  if (r.json?.error) {
    const e = r.json.error;
    // A JSON-RPC error is a verdict too, not a verdict-less hole: grouping the
    // report by verdict must not drop these rows on the floor. -32000 from the
    // extension is a distinct class from an argument-validation -32602.
    const isUpstream = Number(e.code) === -32000;
    const verdict = isUpstream ? "upstream_error" : "rpc_error";
    console.log(`   ${isUpstream ? "⚠️" : "🚫"} [${verdict}] JSON-RPC ${e.code}: ${e.message}  (${secs}s)\n`);
    results.push({ skill: skill.name, question: skill.q, ok: false, verdict,
      retryable: isUpstream, detail: `-${e.code} ${e.message}`, seconds: secs });
    continue;
  }

  const raw = r.json?.result?.content?.[0]?.text ?? "";
  let text = raw;
  let parsed = null;
  // Diagnostic tools answer with pretty-printed JSON; unwrap for readability.
  try {
    parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      text = Object.entries(parsed)
        .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
        .join(" | ");
    }
  } catch { /* plain text answer */ }

  // A 200 carrying "session is not ready" is still an upstream failure.
  //
  // Judge only the field that carries the verdict, never the whole payload:
  // check_bridge_health reports `status: healthy` while its `metrics` block
  // still shows the *historical* last_error ("Extension disconnected") from an
  // earlier blip, and matching on that text marks a healthy bridge as failed.
  const verdictField = parsed && typeof parsed === "object"
    ? String(parsed.status ?? parsed.ok ?? "")
    : "";
  const transportFailure = verdictField
    ? /not ready|disconnected|unavailable|error/i.test(verdictField)
    : /not ready|disconnected|please log in|unavailable/i.test(text);

  // THE CORE FIX: a refusal is not an answer.
  //
  // The old check only looked for session/transport wording, so Gemini's
  // "I encountered an error doing what you asked." scored as a PASS. The
  // bridge reported success while Gemini had returned nothing usable.
  // classifyGeminiReply() splits the three failure shapes apart because they
  // need different remedies — and only some of them are worth retrying.
  const classified = classifyGeminiReply(parsed ? "" : text);

  const verdict = transportFailure
    ? "transport_fail"
    : classified.kind !== REFUSAL_KIND.ANSWERED
      ? classified.kind
      : "answered";

  const ok = verdict === "answered";
  const icon = ok ? "✅" : verdict === "transport_fail" ? "🚫" : "⚠️";

  console.log(`   ${icon} [${verdict}] (${secs}s): ${text.slice(0, 400)}\n`);
  results.push({
    skill: skill.name,
    question: skill.q,
    ok,
    verdict,
    retryable: isRetryWorthwhile(classified.kind),
    answer: text.slice(0, 2000),
    seconds: secs,
  });

  // Sequential by default: the DO runs one browser generation at a time
  // (requestBusy), so firing skills in parallel just queues them into the
  // 60s idle timeout and reports phantom failures.
  if (!noDelay) await new Promise((r) => setTimeout(r, delayMs));
}

const ok = results.filter((r) => r.ok).length;
const byVerdict = results.reduce((acc, r) => {
  acc[r.verdict] = (acc[r.verdict] || 0) + 1;
  return acc;
}, {});
console.log(`═══ ${ok}/${results.length} skills answered ═══`);
console.log(`    by verdict: ${JSON.stringify(byVerdict)}`);
for (const r of results.filter((x) => !x.ok)) {
  console.log(`  ❌ ${r.skill}: [${r.verdict}] ${(r.answer || r.detail || "").slice(0, 120)}`);
}

writeFileSync("/tmp/skills-report.json", JSON.stringify({
  target: BASE, version: health.version, extension_status: health.extension_status,
  timestamp: new Date().toISOString(), ok, total: results.length,
  by_verdict: byVerdict, results,
}, null, 2));
console.log("Report written to /tmp/skills-report.json");
