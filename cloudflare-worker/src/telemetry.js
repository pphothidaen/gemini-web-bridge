// cloudflare-worker/src/telemetry.js
// Native V8 Zero-dependency OpenTelemetry (OTLP/JSON) Distributed Tracing for Cloudflare Workers (KAN-342)

// สร้าง Hex String แบบสุ่ม สำหรับ Trace ID (16 bytes = 32 hex) และ Span ID (8 bytes = 16 hex)
function generateHexId(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function getTraceContext(request) {
  const traceparent = typeof request?.headers?.get === 'function'
    ? request.headers.get('traceparent')
    : (request?.headers?.traceparent || null);
  let traceId = '';
  let parentSpanId = null;

  if (traceparent) {
    const parts = traceparent.split('-');
    if (parts.length === 4 && parts[0] === '00') {
      traceId = parts[1];
      parentSpanId = parts[2];
    }
  }

  if (!traceId) {
    traceId = generateHexId(16);
  }

  const spanId = generateHexId(8);
  return { traceId, spanId, parentSpanId };
}

export function buildTraceparent(traceId, spanId) {
  return `00-${traceId}-${spanId}-01`;
}

export async function exportSpan(env, spanData) {
  const endpoint = env?.GRAFANA_OTLP_ENDPOINT;
  const headersStr = env?.OTEL_EXPORTER_OTLP_HEADERS;

  if (!endpoint || !headersStr) return;

  // แปลง Header จาก "Key=Value,Key2=Value2" เป็น Object โดยรองรับค่า base64 ที่มี '=' ด้านใน
  const headers = { 'Content-Type': 'application/json' };
  headersStr.split(',').forEach(h => {
    const idx = h.indexOf('=');
    if (idx !== -1) {
      const k = h.slice(0, idx).trim();
      let v = h.slice(idx + 1).trim();
      // Remove optional surrounding quotes
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      try {
        if (v.includes('%')) v = decodeURIComponent(v);
      } catch (_) {}
      if (k && v) headers[k] = v;
    }
  });

  const payload = {
    resourceSpans: [{
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: env.OTEL_SERVICE_NAME || "gemini-web-bridge" } }]
      },
      scopeSpans: [{
        spans: [{
          traceId: spanData.traceId,
          spanId: spanData.spanId,
          parentSpanId: spanData.parentSpanId || undefined,
          name: spanData.name,
          kind: 2, // SPAN_KIND_SERVER
          startTimeUnixNano: (spanData.startTime * 1e6).toString(),
          endTimeUnixNano: (spanData.endTime * 1e6).toString(),
          attributes: Object.entries(spanData.attributes || {}).map(([k, v]) => ({
            key: k, value: typeof v === 'number' ? { intValue: v } : { stringValue: String(v) }
          })),
          status: { code: spanData.statusCode >= 200 && spanData.statusCode < 400 ? 1 : 2 } // 1=OK, 2=ERROR
        }]
      }]
    }]
  };

  const url = endpoint.endsWith('/v1/traces') ? endpoint : `${endpoint.replace(/\/$/, '')}/v1/traces`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.error(`OTLP Export HTTP error: ${res.status} ${res.statusText}`);
    }
  } catch (e) {
    console.error("OTLP Export failed:", e);
  }
}
