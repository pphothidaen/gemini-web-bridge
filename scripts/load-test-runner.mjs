#!/usr/bin/env node
/**
 * load-test-runner.mjs -- AI-Driven Load Testing & Bottleneck Analysis (KAN-347)
 * Scenario 1: Step ramp-up 10 VUs -> 25 VUs -> 50 VUs on gemini-web-bridge
 *
 * Requirements:
 * - Zero external dependencies (Node v26+ native ESM, fetch, crypto, perf_hooks, fs).
 * - Step ramp-up concurrency stages (default 10, 25, 50 VUs).
 * - W3C distributed traceparent headers (00-<32hex>-<16hex>-01).
 * - Latency & TTFB statistics (Min, Avg, P90, P95, P99, Max).
 * - Explicit Trace ID for Max Latency request and any failed requests.
 * - Clickable Grafana Cloud Tempo trace links (tempo & grafanacloud-traces).
 * - Robust error, timeout, and pacing boundary handling.
 */

import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { writeFileSync } from 'node:fs';

// ─── CLI Argument Parser ───
export function parseArgs(args = []) {
  const options = {
    target: process.env.TARGET_URL || 'https://prod.gemini-web-bridge.workers.dev',
    stages: [10, 25, 50],
    duration: 6, // seconds per stage (default 6s per stage = ~18s total)
    cycles: null, // if set, overrides duration with fixed requests per VU
    pacing: 100, // ms delay between requests per VU
    timeout: 15000, // ms timeout per individual request
    endpoints: ['/health', '/v1/models'],
    method: 'GET',
    body: null,
    apiKey: process.env.CLIENT_API_KEY || process.env.CLIENT_API_TOKEN || process.env.HERMES_CUSTOM_GEMINI_WEB_BRIDGE_API_KEY || '',
    grafanaBase: process.env.GRAFANA_CLOUD_URL || 'https://cordialgodwit3007.grafana.net',
    datasource: process.env.TEMPO_DATASOURCE || 'tempo',
    outputFile: null,
    json: false,
    failOnError: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--target' || arg === '--base-url') {
      options.target = args[++i];
    } else if (arg === '--stages') {
      const parsedStages = args[++i].split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n > 0);
      if (parsedStages.length > 0) {
        options.stages = parsedStages;
      }
    } else if (arg === '--duration') {
      const dur = parseFloat(args[++i]);
      if (!isNaN(dur) && dur > 0) options.duration = dur;
    } else if (arg === '--cycles') {
      const cyc = parseInt(args[++i], 10);
      if (!isNaN(cyc) && cyc > 0) options.cycles = cyc;
    } else if (arg === '--pacing') {
      const pac = parseInt(args[++i], 10);
      if (!isNaN(pac) && pac >= 0) options.pacing = pac;
    } else if (arg === '--timeout') {
      const tm = parseInt(args[++i], 10);
      if (!isNaN(tm) && tm > 0) options.timeout = tm;
    } else if (arg === '--api-key') {
      options.apiKey = args[++i];
    } else if (arg === '--endpoints') {
      const parsed = args[++i].split(',').map(e => e.trim()).filter(Boolean);
      if (parsed.length > 0) options.endpoints = parsed;
    } else if (arg === '--method') {
      options.method = (args[++i] || 'GET').toUpperCase();
    } else if (arg === '--body') {
      options.body = args[++i];
    } else if (arg === '--grafana-url') {
      options.grafanaBase = args[++i];
    } else if (arg === '--datasource') {
      options.datasource = args[++i];
    } else if (arg === '--output' || arg === '-o') {
      options.outputFile = args[++i];
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--fail-on-error') {
      options.failOnError = true;
    }
  }

  return options;
}

// ─── W3C Traceparent Generator ───
export function generateTraceContext() {
  const traceId = randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  const traceparent = `00-${traceId}-${spanId}-01`;
  return { traceId, spanId, traceparent };
}

// ─── Math & Percentile Helpers ───
export function calculateStats(values) {
  if (!values || values.length === 0) {
    return { count: 0, min: 0, avg: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  }

  const validValues = values.filter(v => typeof v === 'number' && !isNaN(v));
  if (validValues.length === 0) {
    return { count: 0, min: 0, avg: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  }

  const sorted = [...validValues].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const min = sorted[0];
  const max = sorted[count - 1];
  const avg = sum / count;

  const getPercentile = (p) => {
    if (count === 1) return sorted[0];
    const index = (p / 100) * (count - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  };

  return {
    count,
    min,
    avg,
    p90: getPercentile(90),
    p95: getPercentile(95),
    p99: getPercentile(99),
    max
  };
}

// ─── Tempo URL Generator ───
export function buildTempoUrl(grafanaBase, traceId, datasource = 'tempo') {
  const base = grafanaBase.replace(/\/$/, '');
  const pane = {
    tempo: {
      datasource,
      queries: [{ query: traceId, queryType: 'traceql' }]
    }
  };
  return `${base}/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify(pane))}`;
}

export function buildGrafanaCloudTracesUrl(grafanaBase, traceId) {
  return buildTempoUrl(grafanaBase, traceId, 'grafanacloud-traces');
}

// ─── Single Request Execution ───
export async function executeRequest({ target, endpoint, apiKey, vuIndex, stageVUs, timeoutMs = 15000, method = 'GET', body = null }) {
  const { traceId, spanId, traceparent } = generateTraceContext();
  const url = `${target.replace(/\/$/, '')}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

  const headers = {
    'traceparent': traceparent,
    'User-Agent': `hermes-load-test/1.0 (KAN-347; VU-${vuIndex}; Stage-${stageVUs})`,
    'Accept': 'application/json'
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  if (body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const t0 = performance.now();
  let ttfb = 0;
  let latency = 0;
  let status = 0;
  let ok = false;
  let errorMsg = null;
  let bodyBytes = 0;

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    ttfb = performance.now() - t0;
    status = res.status;
    ok = res.ok;

    const bodyText = await res.text();
    latency = performance.now() - t0;
    bodyBytes = Buffer.byteLength(bodyText, 'utf8');

    if (!res.ok) {
      errorMsg = `HTTP ${status}: ${bodyText.slice(0, 120)}`;
    }
  } catch (err) {
    latency = performance.now() - t0;
    if (ttfb === 0) {
      ttfb = latency;
    }
    status = 0;
    ok = false;
    errorMsg = err.name === 'TimeoutError'
      ? `Request timeout after ${timeoutMs}ms`
      : (err.message || 'Unknown network error');
  }

  return {
    traceId,
    spanId,
    endpoint,
    status,
    ok,
    errorMsg,
    ttfb,
    latency,
    bodyBytes,
    vuIndex,
    stageVUs,
    timestamp: Date.now()
  };
}

// ─── Stage Runner ───
async function runStage({ stageVUs, stageIndex, totalStages, config }) {
  if (!config.json) {
    console.log(`\n================================================================================`);
    console.log(`[STAGE ${stageIndex + 1}/${totalStages}] Concurrency: ${stageVUs} VUs | Mode: ${config.cycles ? `${config.cycles} cycles/VU` : `${config.duration}s burst`}`);
    console.log(`Target: ${config.target} | Endpoints: ${config.endpoints.join(', ')}`);
    console.log(`================================================================================`);
  }

  const stageResults = [];
  const stageStartTime = performance.now();
  const stageDurationMs = config.duration * 1000;
  const stageEndTime = stageStartTime + stageDurationMs;

  const vuTasks = Array.from({ length: stageVUs }, async (_, vuIdx) => {
    let cycleCount = 0;
    while (true) {
      if (config.cycles !== null) {
        if (cycleCount >= config.cycles) break;
      } else {
        if (performance.now() >= stageEndTime) break;
      }

      // Alternate endpoints across iterations & VUs
      const endpoint = config.endpoints[(vuIdx + cycleCount) % config.endpoints.length];
      const result = await executeRequest({
        target: config.target,
        endpoint,
        apiKey: config.apiKey,
        vuIndex: vuIdx,
        stageVUs,
        timeoutMs: config.timeout,
        method: config.method,
        body: config.body
      });

      stageResults.push(result);
      cycleCount++;

      // Stop immediately if stage duration expired before pacing sleep
      if (config.cycles === null && performance.now() >= stageEndTime) {
        break;
      }

      if (config.pacing > 0) {
        await new Promise(r => setTimeout(r, config.pacing));
      }
    }
  });

  await Promise.all(vuTasks);
  const actualStageDurationMs = performance.now() - stageStartTime;

  return {
    stageVUs,
    durationMs: actualStageDurationMs,
    results: stageResults
  };
}

// ─── Format Summary Table & Outliers ───
export function generateReportData(stageRuns, config) {
  const allResults = stageRuns.flatMap(s => s.results);
  const totalDurationSec = stageRuns.reduce((acc, s) => acc + s.durationMs, 0) / 1000;
  const successResults = allResults.filter(r => r.ok);
  const errorResults = allResults.filter(r => !r.ok);
  const successRate = allResults.length > 0 ? (successResults.length / allResults.length) * 100 : 0;
  const overallThroughput = totalDurationSec > 0 ? allResults.length / totalDurationSec : 0;

  const overallLatStats = calculateStats(allResults.map(r => r.latency));
  const overallTtfbStats = calculateStats(allResults.map(r => r.ttfb));
  const successLatStats = calculateStats(successResults.map(r => r.latency));

  const slowestRequest = allResults.length > 0
    ? [...allResults].sort((a, b) => b.latency - a.latency)[0]
    : null;

  const slowestSuccessRequest = successResults.length > 0
    ? [...successResults].sort((a, b) => b.latency - a.latency)[0]
    : null;

  const stagesSummary = stageRuns.map(stage => {
    const sResults = stage.results;
    const sDurationSec = stage.durationMs / 1000;
    const rps = sDurationSec > 0 ? sResults.length / sDurationSec : 0;
    const sSuccess = sResults.filter(r => r.ok).length;
    const sErrors = sResults.length - sSuccess;
    const ttfbStats = calculateStats(sResults.map(r => r.ttfb));
    const latStats = calculateStats(sResults.map(r => r.latency));

    return {
      stageVUs: stage.stageVUs,
      requestsCount: sResults.length,
      durationSec: sDurationSec,
      rps,
      successCount: sSuccess,
      errorCount: sErrors,
      ttfbStats,
      latencyStats: latStats
    };
  });

  return {
    target: config.target,
    totalStages: stageRuns.length,
    totalRequests: allResults.length,
    successCount: successResults.length,
    errorCount: errorResults.length,
    successRate: parseFloat(successRate.toFixed(2)),
    totalDurationSec: parseFloat(totalDurationSec.toFixed(2)),
    overallThroughput: parseFloat(overallThroughput.toFixed(2)),
    stagesSummary,
    overallLatStats,
    overallTtfbStats,
    successLatStats,
    slowestRequest,
    slowestSuccessRequest,
    errorResults
  };
}

function printSummary(stageRuns, config) {
  const report = generateReportData(stageRuns, config);

  console.log(`\n\n`);
  console.log(`================================================================================`);
  console.log(`                  KAN-347 LOAD TEST EXECUTION REPORT                            `);
  console.log(`================================================================================`);
  console.log(`Target Service:       ${report.target}`);
  console.log(`Total Stages:         ${report.totalStages} (${config.stages.join(' -> ')} VUs)`);
  console.log(`Total Requests:       ${report.totalRequests}`);
  console.log(`Total Duration:       ${report.totalDurationSec}s`);
  console.log(`Overall Throughput:   ${report.overallThroughput} req/sec`);
  console.log(`Success Rate:         ${report.successRate.toFixed(2)}% (${report.successCount}/${report.totalRequests})`);

  // Stage-by-Stage Breakdown
  console.log(`\n--- STAGE-BY-STAGE LATENCY & TTFB BREAKDOWN ---`);
  const stageHeader = `Stage   | Requests | RPS    | HTTP 2xx | HTTP Err | TTFB Avg (ms) | Latency Avg | Latency P95 | Latency Max`;
  console.log(stageHeader);
  console.log('-'.repeat(stageHeader.length));

  for (const stg of report.stagesSummary) {
    const stageLabel = `${stg.stageVUs} VUs`.padEnd(7);
    const reqCol = String(stg.requestsCount).padStart(8);
    const rpsCol = stg.rps.toFixed(1).padStart(6);
    const succCol = String(stg.successCount).padStart(8);
    const errCol = String(stg.errorCount).padStart(8);
    const ttfbCol = stg.ttfbStats.avg.toFixed(1).padStart(13);
    const latAvgCol = stg.latencyStats.avg.toFixed(1).padStart(11);
    const latP95Col = stg.latencyStats.p95.toFixed(1).padStart(11);
    const latMaxCol = stg.latencyStats.max.toFixed(1).padStart(11);

    console.log(`${stageLabel} | ${reqCol} | ${rpsCol} | ${succCol} | ${errCol} | ${ttfbCol} | ${latAvgCol} | ${latP95Col} | ${latMaxCol}`);
  }

  // Latency Percentile Summary (Overall)
  console.log(`\n--- OVERALL LATENCY PERCENTILES ---`);
  console.log(`Metric   | Min      | Avg      | P90      | P95      | P99      | Max`);
  console.log(`---------+----------+----------+----------+----------+----------+----------`);
  console.log(`TTFB     | ${report.overallTtfbStats.min.toFixed(1).padStart(8)} | ${report.overallTtfbStats.avg.toFixed(1).padStart(8)} | ${report.overallTtfbStats.p90.toFixed(1).padStart(8)} | ${report.overallTtfbStats.p95.toFixed(1).padStart(8)} | ${report.overallTtfbStats.p99.toFixed(1).padStart(8)} | ${report.overallTtfbStats.max.toFixed(1).padStart(8)} ms`);
  console.log(`Total RT | ${report.overallLatStats.min.toFixed(1).padStart(8)} | ${report.overallLatStats.avg.toFixed(1).padStart(8)} | ${report.overallLatStats.p90.toFixed(1).padStart(8)} | ${report.overallLatStats.p95.toFixed(1).padStart(8)} | ${report.overallLatStats.p99.toFixed(1).padStart(8)} | ${report.overallLatStats.max.toFixed(1).padStart(8)} ms`);

  // Max Latency Outlier Detail (Trace ID & Tempo Waterfall)
  if (report.slowestRequest) {
    const maxLatReq = report.slowestRequest;
    const tempoLink = buildTempoUrl(config.grafanaBase, maxLatReq.traceId, config.datasource);
    const grafanaCloudLink = buildGrafanaCloudTracesUrl(config.grafanaBase, maxLatReq.traceId);

    console.log(`\n================================================================================`);
    console.log(`🚨 SLOWEST REQUEST (MAX LATENCY OUTLIER - FOR WATERFALL ANALYSIS)`);
    console.log(`================================================================================`);
    console.log(`Trace ID:             ${maxLatReq.traceId}`);
    console.log(`Span ID:              ${maxLatReq.spanId}`);
    console.log(`Endpoint:             ${maxLatReq.endpoint}`);
    console.log(`HTTP Status:          ${maxLatReq.status}${maxLatReq.ok ? ' (OK)' : ` (Error: ${maxLatReq.errorMsg})`}`);
    console.log(`Latency:              ${maxLatReq.latency.toFixed(2)} ms`);
    console.log(`TTFB:                 ${maxLatReq.ttfb.toFixed(2)} ms`);
    console.log(`Stage:                ${maxLatReq.stageVUs} VUs (VU index ${maxLatReq.vuIndex})`);
    console.log(`Tempo URL:            ${tempoLink}`);
    console.log(`Grafana Cloud Traces: ${grafanaCloudLink}`);
    console.log(`TraceQL Query:        { .traceId = "${maxLatReq.traceId}" }`);
  }

  // Error Outliers (if any)
  if (report.errorCount > 0) {
    console.log(`\n================================================================================`);
    console.log(`❌ FAILED REQUEST TRACES (${report.errorCount} ERRORS DETECTED)`);
    console.log(`================================================================================`);
    const sampleErrors = report.errorResults.slice(0, 5);
    sampleErrors.forEach((errReq, idx) => {
      console.log(`[Error #${idx + 1}]`);
      console.log(`  Trace ID:           ${errReq.traceId}`);
      console.log(`  Endpoint:           ${errReq.endpoint} (Stage: ${errReq.stageVUs} VUs)`);
      console.log(`  Status/Error:       ${errReq.status} -> ${errReq.errorMsg}`);
      console.log(`  Tempo URL:          ${buildTempoUrl(config.grafanaBase, errReq.traceId, config.datasource)}`);
      console.log(`  Grafana Cloud:      ${buildGrafanaCloudTracesUrl(config.grafanaBase, errReq.traceId)}`);
    });
    if (report.errorCount > 5) {
      console.log(`  ... and ${report.errorCount - 5} more error traces.`);
    }
  } else {
    console.log(`\n✅ Zero HTTP or network errors observed across all ${report.totalRequests} requests.`);
  }

  console.log(`================================================================================\n`);
}

// ─── Main Entry Point ───
export async function runLoadTest(customArgs = process.argv.slice(2)) {
  const config = parseArgs(customArgs);

  if (config.help) {
    console.log(`
Usage: node load-test-runner.mjs [options]

Options:
  --target <url>       Target base URL (default: https://prod.gemini-web-bridge.workers.dev)
  --stages <vus>       Comma-separated list of VU stages (default: 10,25,50)
  --duration <sec>     Duration per stage in seconds (default: 6)
  --cycles <n>         Fixed request cycles per VU (overrides --duration)
  --pacing <ms>        Delay between requests per VU in ms (default: 100)
  --timeout <ms>       Request timeout in ms (default: 15000)
  --endpoints <paths>  Comma-separated list of endpoints (default: /health,/v1/models)
  --method <verb>      HTTP method (default: GET)
  --body <string>      Request body string for POST/PUT
  --api-key <token>    Bearer token for protected endpoints
  --grafana-url <url>  Grafana Cloud instance base URL
  --datasource <ds>    Tempo datasource name (default: tempo)
  --output <file>      Save execution report JSON to file
  --json               Output report in JSON format only
  --fail-on-error      Exit with status code 1 if any request fails
  -h, --help           Show this help message
`);
    return { ok: true, help: true };
  }

  if (!config.json) {
    console.log(`[KAN-347] Starting Load Test Runner (Scenario 1: 10 -> 25 -> 50 VUs)`);
    console.log(`Target: ${config.target}`);
    console.log(`Stages: ${config.stages.join(' -> ')} VUs`);
    console.log(`Endpoints: ${config.endpoints.join(', ')}`);
    console.log(`Pacing: ${config.pacing}ms | Stage Duration: ${config.duration}s | Timeout: ${config.timeout}ms`);
    console.log(`Grafana Tempo Base: ${config.grafanaBase}`);
  }

  const stageRuns = [];

  for (let i = 0; i < config.stages.length; i++) {
    const stageVUs = config.stages[i];
    const stageResult = await runStage({
      stageVUs,
      stageIndex: i,
      totalStages: config.stages.length,
      config
    });
    stageRuns.push(stageResult);
  }

  const report = generateReportData(stageRuns, config);

  if (config.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printSummary(stageRuns, config);
  }

  if (config.outputFile) {
    try {
      writeFileSync(config.outputFile, JSON.stringify(report, null, 2), 'utf8');
      if (!config.json) console.log(`Report successfully written to ${config.outputFile}`);
    } catch (err) {
      console.error(`Failed to write report to ${config.outputFile}:`, err.message);
    }
  }

  // Determine overall success:
  // If all requests failed, or failOnError is true with > 0 errors, ok = false
  const ok = report.totalRequests > 0 && report.errorCount === 0;

  return { ok, report, stageRuns, config };
}

// Auto-run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runLoadTest().then(result => {
    if (result.help) process.exit(0);
    if (!result.ok && (result.config.failOnError || result.report?.successCount === 0)) {
      process.exit(1);
    }
  }).catch(err => {
    console.error('Fatal load test runner error:', err);
    process.exit(1);
  });
}
