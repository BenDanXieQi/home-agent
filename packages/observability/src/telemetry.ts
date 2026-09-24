import {
  context,
  propagation,
  trace,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  BasicTracerProvider,
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
  LANGSMITH_ENDPOINT: endpoint,
  LANGSMITH_API_KEY: optionalText,
  LANGSMITH_PROJECT: z.string().min(1).default("home-agent"),
  LANGSMITH_WORKSPACE_ID: optionalText,
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
  // This application exports a single OTel tree, never parallel LangSmith REST runs.
  // The installed @langchain/core enables tracing if ANY of these flags is true.
  // Disable every trigger to prevent duplicate exports and unintended content capture.
  process.env.LANGSMITH_TRACING = "false";
  process.env.LANGSMITH_TRACING_V2 = "false";
  process.env.LANGCHAIN_TRACING = "false";
  process.env.LANGCHAIN_TRACING_V2 = "false";
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
  if (
    config.OTEL_TRACES_EXPORTER === "otlp" &&
    !customEndpoint &&
    !config.LANGSMITH_API_KEY
  ) {
    throw new Error(
      "Set LANGSMITH_API_KEY for direct export, or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT for a collector",
    );
  }
  const processor =
    config.OTEL_TRACES_EXPORTER === "console"
      ? new SimpleSpanProcessor(new ConsoleSpanExporter())
      : new BatchSpanProcessor(
          new OTLPTraceExporter({
            url:
              customEndpoint ??
              `${(config.LANGSMITH_ENDPOINT ?? "https://api.smith.langchain.com").replace(/\/$/, "")}/otel/v1/traces`,
            // Custom collectors use standard OTEL_EXPORTER_OTLP_*_HEADERS; no LangSmith key is forwarded.
            ...(customEndpoint
              ? {}
              : {
                  headers: {
                    "x-api-key": config.LANGSMITH_API_KEY!,
                    "Langsmith-Project": config.LANGSMITH_PROJECT,
                    ...(config.LANGSMITH_WORKSPACE_ID
                      ? { "x-tenant-id": config.LANGSMITH_WORKSPACE_ID }
                      : {}),
                  },
                }),
            timeoutMillis: 10_000,
          }),
          { scheduledDelayMillis: 1_000, exportTimeoutMillis: 12_000 },
        );
  const provider = new BasicTracerProvider({
    resource: defaultResource().merge(
      resourceFromAttributes({ "service.name": serviceName }),
    ),
    spanProcessors: [processor],
  });
  const manager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(manager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  enabled = true;
  state = {
    shutdown: async () => {
      await drainOperations();
      await provider.shutdown();
      manager.disable();
    },
  };
  return state;
}
