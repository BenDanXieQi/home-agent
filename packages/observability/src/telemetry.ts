import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { z } from "zod";
import { drainOperations } from "./lifecycle";

const optionalText = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional(),
);
const endpoint = optionalText.pipe(
  z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    })
    .optional(),
);
const schema = z.object({
  OTEL_TRACES_EXPORTER: z.enum(["none", "console", "otlp"]).default("none"),
  OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint,
  OTEL_INCLUDE_CONTENT: z.enum(["true", "false"]).default("false"),
  LANGFUSE_BASE_URL: endpoint,
  LANGFUSE_PUBLIC_KEY: optionalText,
  LANGFUSE_SECRET_KEY: optionalText,
});

let state: { shutdown: () => Promise<void> } | undefined;
let enabled = false;
let includeContent = false;

export function telemetryStatus() {
  return { enabled, includeContent };
}

export function initializeTelemetry(serviceName: string) {
  if (state) return state;
  const result = schema.safeParse(process.env);
  if (!result.success) {
    throw new Error(
      `Invalid telemetry configuration: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  }
  const config = result.data;
  includeContent = config.OTEL_INCLUDE_CONTENT === "true";
  if (config.OTEL_TRACES_EXPORTER === "none") {
    state = { shutdown: drainOperations };
    return state;
  }

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);
  const customEndpoint =
    config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    (config.OTEL_EXPORTER_OTLP_ENDPOINT
      ? `${config.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces`
      : undefined);
  const spanProcessors = [];
  if (config.OTEL_TRACES_EXPORTER === "console") {
    spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  } else if (customEndpoint) {
    spanProcessors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: customEndpoint,
          // Custom collectors use standard OTEL_EXPORTER_OTLP_*_HEADERS.
          timeoutMillis: 10_000,
        }),
        { scheduledDelayMillis: 1_000, exportTimeoutMillis: 12_000 },
      ),
    );
  } else {
    if (!config.LANGFUSE_PUBLIC_KEY || !config.LANGFUSE_SECRET_KEY) {
      throw new Error(
        "Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY for direct export, or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT for a collector",
      );
    }
    spanProcessors.push(
      new LangfuseSpanProcessor({
        publicKey: config.LANGFUSE_PUBLIC_KEY,
        secretKey: config.LANGFUSE_SECRET_KEY,
        baseUrl: (
          config.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com"
        ).replace(/\/$/, ""),
        // Retain HTTP and application ancestors of model observations.
        shouldExportSpan: () => true,
        flushInterval: 1,
        timeout: 10,
      }),
    );
  }
  const sdk = new NodeSDK({
    autoDetectResources: false,
    resource: defaultResource().merge(
      resourceFromAttributes({ "service.name": serviceName }),
    ),
    spanProcessors,
  });
  sdk.start();
  enabled = true;
  state = {
    shutdown: async () => {
      await drainOperations();
      await sdk.shutdown();
    },
  };
  return state;
}
