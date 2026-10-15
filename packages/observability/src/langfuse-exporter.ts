import {
  OTLPExporterBase,
  getSharedConfigurationDefaults,
} from "@opentelemetry/otlp-exporter-base";
import {
  createOtlpHttpExportDelegate,
  httpAgentFactoryFromOptions,
} from "@opentelemetry/otlp-exporter-base/node-http";
import {
  ProtobufTraceSerializer,
  TraceExporterMetricsHelper,
} from "@opentelemetry/otlp-transformer";

export function createLangfuseTraceExporter(
  url: string,
  authorization: string,
) {
  return new OTLPExporterBase(
    createOtlpHttpExportDelegate(
      {
        ...getSharedConfigurationDefaults(),
        url,
        headers: async () => ({
          "Content-Type": "application/x-protobuf",
          Authorization: `Basic ${authorization}`,
          "x-langfuse-ingestion-version": "4",
        }),
        agentFactory: httpAgentFactoryFromOptions({ keepAlive: true }),
      },
      ProtobufTraceSerializer,
      "otlp_http_span_exporter",
      TraceExporterMetricsHelper,
      undefined,
    ),
  );
}
