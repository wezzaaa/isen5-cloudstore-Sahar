import { NodeSDK } from '@opentelemetry/sdk-node';
import { AlwaysOnSampler } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { AggregationType } from '@opentelemetry/sdk-metrics';

//potential trap: Compose already mentioned an OTLP endpoint, but an endpoint alone does not initialize telemetry, an SDK must record and export spans.
// potential trap: the /metrics comment mentioned prom-client. we use an OTel metric reader and expose its Prometheus output through the existing Express endpoint, preventServerStart avoids opening a separate metrics server on port 9464
export const prometheusExporter = new PrometheusExporter({
  preventServerStart: true,
});

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    'service.name': 'service-a-auth',
  }),

  //potential trap: port 4317 could be used with an HTTP exporter, but 4317 is for gRPC, HTTP uses 4318.
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      || 'http://otel-collector:4317',
  }),

  //potential trap: a manual "01" trace flag does not configure SDK sampling., sample 100% in development
  sampler: new AlwaysOnSampler(),
  metricReaders: [prometheusExporter],
  views: [
    {
      instrumentName: 'http_request_duration_seconds',
      aggregation: {
        type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
        options: {
          boundaries: [
            0.005, 0.01, 0.025, 0.05, 0.1,
            0.25, 0.5, 1, 2.5, 5, 10,
          ],
        },
      },
    },
  ],

  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation(),

    // potential trap: HTTP instrumentation alone does not cover Node's fetch implementation. Undici instrumentation covers those calls
    new UndiciInstrumentation(),
  ],
});

sdk.start();

//potential trap: exiting immediately can lose buffered spans. flush telemetry through SDK shutdown before exiting
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    sdk.shutdown()
      .then(() => process.exit(0))
      .catch((error) => {
        // potential trap: this console.error produced plain text, but application error logs must be structured JSON.
        console.error(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'error',
          service: 'service-a-auth',
          event: 'telemetry.shutdown.failed',
          trace_id: null,
          span_id: null,
          error_message:
            error instanceof Error ? error.message : 'Unknown error',
        }));
        process.exit(1);
      });
  });
}