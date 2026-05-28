/**
 * OTel tracer and meter instances.
 *
 * When no SDK is initialised (OTEL_ENABLED is not set), @opentelemetry/api
 * returns no-op implementations — zero overhead, no errors, no config required.
 *
 * To enable telemetry, set OTEL_ENABLED=true and optionally:
 *   OTEL_EXPORTER_OTLP_ENDPOINT  — default: http://localhost:4318
 *   OTEL_SERVICE_NAME             — default: trustvc-webhook-events
 */
import { trace, metrics } from '@opentelemetry/api';

export const tracer = trace.getTracer('trustvc-webhook-events');
export const meter = metrics.getMeter('trustvc-webhook-events');
