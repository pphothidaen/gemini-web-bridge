import { strict as assert } from 'node:assert';
import test from 'node:test';
import { getTraceContext, buildTraceparent, exportSpan } from '../src/telemetry.js';

test('W3C Trace Context extraction and propagation', async (t) => {
  await t.test('extracts traceId and parentSpanId from valid traceparent header', () => {
    const mockRequestWithHeader = {
      headers: new Map([['traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01']])
    };

    const ctx = getTraceContext(mockRequestWithHeader);
    assert.equal(ctx.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.equal(ctx.parentSpanId, '00f067aa0ba902b7');
    assert.ok(ctx.spanId);
    assert.equal(ctx.spanId.length, 16);
  });

  await t.test('generates new root traceId when traceparent is missing', () => {
    const mockRequestWithoutHeader = {
      headers: new Map()
    };

    const ctx = getTraceContext(mockRequestWithoutHeader);
    assert.ok(ctx.traceId);
    assert.equal(ctx.traceId.length, 32);
    assert.ok(ctx.spanId);
    assert.equal(ctx.spanId.length, 16);
    assert.equal(ctx.parentSpanId, null);
  });

  await t.test('builds valid W3C traceparent header', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    const header = buildTraceparent(traceId, spanId);

    assert.equal(header, '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    assert.ok(header.startsWith('00-'));
    assert.ok(header.endsWith('-01'));
  });

  await t.test('exportSpan builds payload and calls fetch with correct auth headers', async () => {
    let capturedUrl = null;
    let capturedOptions = null;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return new Response(JSON.stringify({}), { status: 200 });
    };

    try {
      const mockEnv = {
        GRAFANA_OTLP_ENDPOINT: 'https://otlp-gateway-prod-ap-southeast-1.grafana.net/otlp',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic MTkyMTU2ODpnbGNf...',
        OTEL_SERVICE_NAME: 'gemini-web-bridge'
      };

      await exportSpan(mockEnv, {
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        spanId: '00f067aa0ba902b7',
        name: 'HTTP GET /health',
        startTime: 1000,
        endTime: 1050,
        statusCode: 200,
        attributes: {
          'http.method': 'GET',
          'http.url': 'https://prod.gemini-web-bridge.workers.dev/health'
        }
      });

      assert.equal(capturedUrl, 'https://otlp-gateway-prod-ap-southeast-1.grafana.net/otlp/v1/traces');
      assert.equal(capturedOptions.headers['Authorization'], 'Basic MTkyMTU2ODpnbGNf...');
      assert.equal(capturedOptions.headers['Content-Type'], 'application/json');

      const body = JSON.parse(capturedOptions.body);
      assert.equal(body.resourceSpans[0].resource.attributes[0].value.stringValue, 'gemini-web-bridge');
      assert.equal(body.resourceSpans[0].scopeSpans[0].spans[0].traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
      assert.equal(body.resourceSpans[0].scopeSpans[0].spans[0].status.code, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
