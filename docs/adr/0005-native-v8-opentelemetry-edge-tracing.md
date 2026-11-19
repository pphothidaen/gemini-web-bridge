# ADR-005: Native V8 OpenTelemetry Distributed Tracing on Edge

## Metadata
- **Status:** Accepted
- **Date:** 2026-11-19
- **Author:** Hermes Agent / Kim Leng Lim
- **Ticket:** KAN-342 (Observability)
- **Supersedes:** None (enhancement to edge telemetry)

## Context
Gemini Web Bridge ทำหน้าที่เป็น Edge-to-Browser Gateway ระหว่าง AI Clients และ Google Gemini Session การทำงานแบบ distributed และ asynchronous มีความจำเป็นต้องมี distributed tracing เพื่อให้:
- สามารถสืบค้น latency และ trace request จาก AI Client ผ่าน Cloudflare Worker จนถึง Durable Objects และ Browser Extension ได้
- ปฏิบัติตามมาตรฐาน W3C Trace Context (`traceparent` header format: `00-<trace_id>-<span_id>-01`)
- ส่งออก OTLP/JSON spans ไปยัง Grafana Cloud / OpenTelemetry Collector (`GRAFANA_OTLP_ENDPOINT`) ได้แบบ real-time
- อยู่ภายใต้ข้อจำกัดของ Cloudflare Workers Free Tier (CPU execution budget และ bundle size limits) โดยไม่นำเข้า external npm packages ที่มี dependency ขนาดใหญ่ เช่น `@opentelemetry/sdk-trace-base`

## Decision
นำสถาปัตยกรรม **Zero-Dependency Native V8 OpenTelemetry Distributed Tracing** มาใช้ใน `cloudflare-worker/src/telemetry.js`:

1. **Native V8 Cryptography:** ใช้ Web Crypto API (`crypto.getRandomValues`) ในการสร้าง 16-byte Hex Trace ID และ 8-byte Hex Span ID โดยไม่มี external dependencies
2. **W3C Trace Context Extraction & Propagation:** แยกแยะและสกัด `traceparent` header จาก incoming HTTP requests หากไม่มีอยู่จะสร้าง root trace ID ใหม่ และ inject trace context ไปยัง request spans
3. **OTLP/JSON Direct Exporter:** ส่งออก OpenTelemetry payload ในรูปแบบ OTLP/JSON ไปยัง `GRAFANA_OTLP_ENDPOINT` ด้วย HTTP POST แบบ non-blocking พร้อมรองรับ `OTEL_EXPORTER_OTLP_HEADERS` และ `OTEL_SERVICE_NAME`
4. **Configuration Synchronization:** กำหนดค่า `OTEL_SERVICE_NAME = "gemini-web-bridge"` ในทั้ง `cloudflare-worker/wrangler.toml` และ root `wrangler.jsonc` เพื่อความสอดคล้องของ environment configuration

## Consequences

### Positive
- **Zero bundle bloat:** ไม่มี dependencies ภายนอก ขนาด bundle worker เล็ก รันบน V8 isolate ได้รวดเร็ว
- **Standard compliance:** รองรับ W3C Trace Context และ OTLP/JSON spec อย่างครบถ้วน
- **End-to-end visibility:** ทำงานร่วมกับ Grafana Cloud และ Loki ได้อย่างไร้รอยต่อ
- **Free-tier friendly:** ใช้ CPU overhead ต่ำมาก ป้องกันข้อผิดพลาดเรื่อง CPU limit บน Cloudflare Free tier

### Negative
- **Scoped exporter:** รองรับเฉพาะ OTLP/JSON HTTP POST exporter เท่านั้น (ไม่รองรับ gRPC)
- **Lifecycle dependency:** การส่ง trace แบบ async ทำงานใน context ของ fetch event หาก worker terminate ทันทีอาจมีโอกาส drop telemetry หากไม่ await หรือใช้ `ctx.waitUntil`

## Alternatives Considered

| Alternative | Reason for Rejection |
|-------------|---------------------|
| Official `@opentelemetry/api` + SDK | ขนาด bundle ใหญ่เกินไปและมี polyfill สำหรับ Node.js API หลายตัวที่ไม่จำเป็นบน V8 edge |
| Built-in Cloudflare Workers Logs | ถูกคิดค่าใช้จ่ายใน CPU execution budget เดียวกันกับ Durable Objects และขาดการ format spans ตามมาตรฐาน OpenTelemetry |
| Client-only tracing | ไม่สามารถเห็น latency หรือ span ภายใน edge worker และ Durable Objects ได้ |

## Related
- `cloudflare-worker/src/telemetry.js` — Native V8 OpenTelemetry implementation
- `cloudflare-worker/src/index.js` — Trace context propagation and server span timing
- `cloudflare-worker/tests/tracing.test.mjs` — OpenTelemetry unit & integration tests
- `cloudflare-worker/wrangler.toml` & `wrangler.jsonc` — Service configuration
