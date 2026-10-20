import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { z } from "zod";
import { drainOperations } from "./lifecycle";
import { AgentTraceMarker, LangfuseAgentSpanProcessor } from "./agent-trace";
import { createLangfuseTraceExporter } from "./langfuse-exporter";

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
  OTEL_TRACES_EXPORTER: optionalText.pipe(
    z.enum(["none", "console", "otlp"]).optional(),
  ),
  OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint,
  OTEL_INCLUDE_CONTENT: z.enum(["true", "false"]).default("false"),
  COMPOSE_PROFILES: optionalText,
  LANGFUSE_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LANGFUSE_BASE_URL: endpoint,
  LANGFUSE_PUBLIC_KEY: optionalText,
  LANGFUSE_SECRET_KEY: optionalText,
  LANGFUSE_TRACING_ENABLED: z.enum(["true", "false"]).default("true"),
});

let state: { shutdown: () => Promise<void> } | undefined;
let enabled = false;
let includeContent = false;
let flush = () => Promise.resolve();

export function flushTelemetry() {
  return flush();
}

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
  const customEndpoint =
    config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    (config.OTEL_EXPORTER_OTLP_ENDPOINT
      ? `${config.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces`
      : undefined);
  const langfuseEnabled =
    config.LANGFUSE_TRACING_ENABLED === "true" &&
    Boolean(config.LANGFUSE_PUBLIC_KEY && config.LANGFUSE_SECRET_KEY);
  const exporter =
    config.OTEL_TRACES_EXPORTER ??
    (customEndpoint || langfuseEnabled ? "otlp" : "none");
  const localLangfuse = config.COMPOSE_PROFILES?.split(",").some(
    (profile) => profile.trim() === "langfuse",
  );
  if (exporter === "none") {
    state = { shutdown: drainOperations };
    return state;
  }

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);
  if (exporter === "otlp" && !customEndpoint && !langfuseEnabled) {
    throw new Error(
      "Set an OTLP collector endpoint or enable Langfuse with LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY",
    );
  }
  const spanProcessors: SpanProcessor[] = [new AgentTraceMarker()];
  if (exporter === "console") {
    spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  } else if (customEndpoint) {
    spanProcessors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: customEndpoint,
          timeoutMillis: 10_000,
        }),
        { scheduledDelayMillis: 1_000 },
      ),
    );
  }
  if (langfuseEnabled) {
    const baseUrl = (
      config.LANGFUSE_BASE_URL ??
      (localLangfuse
        ? `http://localhost:${config.LANGFUSE_PORT}`
        : "https://cloud.langfuse.com")
    ).replace(/\/$/, "");
    const authorization = Buffer.from(
      `${config.LANGFUSE_PUBLIC_KEY}:${config.LANGFUSE_SECRET_KEY}`,
    ).toString("base64");
    spanProcessors.push(
      new LangfuseAgentSpanProcessor(
        createLangfuseTraceExporter(
          `${baseUrl}/api/public/otel/v1/traces`,
          authorization,
        ),
        { scheduledDelayMillis: 1_000 },
      ),
    );
  }
  const sdk = new NodeSDK({
    autoDetectResources: false,
    resource: defaultResource().merge(
      resourceFromAttributes({ "service.name": serviceName }),
    ),
    spanProcessors,
    metricReaders: [],
    logRecordProcessors: [],
  });
  sdk.start();
  flush = async () => {
    await Promise.all(
      spanProcessors.map((processor) => processor.forceFlush()),
    );
  };
  enabled = true;
  state = {
    shutdown: async () => {
      await drainOperations();
      await sdk.shutdown();
    },
  };
  return state;
}
