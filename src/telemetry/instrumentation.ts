/**
 * OTel SDK bootstrap — loaded via --import before src/index.ts.
 *
 * Opt in by setting OTEL_ENABLED=true. The SDK and all its dependencies are
 * loaded dynamically only when the flag is set, so omitting it adds zero
 * overhead and causes no failures. All other OTel env vars are optional:
 *
 *   OTEL_ENABLED=true
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318   (default)
 *   OTEL_SERVICE_NAME=trustvc-webhook-events             (default)
 */
if (process.env['OTEL_ENABLED'] === 'true') {
  try {
    const [
      { NodeSDK },
      { getNodeAutoInstrumentations },
      { OTLPTraceExporter },
      { OTLPMetricExporter },
      { PeriodicExportingMetricReader },
      { resourceFromAttributes },
      { PinoInstrumentation },
    ] = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/auto-instrumentations-node'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/exporter-metrics-otlp-http'),
      import('@opentelemetry/sdk-metrics'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/instrumentation-pino'),
    ]);

    const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4318';
    const { hostname } = await import('node:os');
    const instanceId = process.env['OTEL_INSTANCE_ID'] ?? `${hostname()}-${process.pid}`;

    const { readFileSync } = await import('node:fs');
    let serviceVersion = process.env['npm_package_version'] ?? 'unknown';
    try {
      serviceVersion = (
        JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
      ).version;
    } catch {
      // keep the npm_package_version fallback
    }

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        'service.name': process.env['OTEL_SERVICE_NAME'] ?? 'trustvc-webhook-events',
        'service.version': serviceVersion,
        'service.instance.id': instanceId,
      }),
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
        exportIntervalMillis: 15_000,
      }),
      instrumentations: [
        getNodeAutoInstrumentations({
          // fs instrumentation generates thousands of spans on startup — not useful here.
          '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
        new PinoInstrumentation(),
      ],
    });

    sdk.start();
    process.on('SIGTERM', () => void sdk.shutdown());
    process.on('SIGINT', () => void sdk.shutdown());
  } catch (err) {
    console.warn(
      '[telemetry] Failed to initialise OTel SDK — running without telemetry:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
