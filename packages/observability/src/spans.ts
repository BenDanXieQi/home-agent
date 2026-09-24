import {
  trace,
  SpanStatusCode,
  type Span,
  type Attributes,
} from "@opentelemetry/api";
import { beginOperation } from "./lifecycle";
import { telemetryStatus } from "./telemetry";

export { context, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";

export function currentTraceId() {
  const id = trace.getActiveSpan()?.spanContext().traceId;
  return id && id !== "00000000000000000000000000000000" ? id : undefined;
}

export function recordFailure(span: Span, error: unknown) {
  // Error messages from model providers may contain prompts or credentials.
  const message =
    telemetryStatus().includeContent && error instanceof Error
      ? error.message
      : "Operation failed";
  span.setStatus({ code: SpanStatusCode.ERROR, message });
  span.recordException({
    name: error instanceof Error ? error.name : "Error",
    message,
  });
}

export function withSpan<T>(
  name: string,
  attributes: Attributes,
  run: (span: Span) => Promise<T>,
): Promise<T> {
  return trace
    .getTracer("home-agent")
    .startActiveSpan(name, { attributes }, async (span) => {
      const finish = beginOperation();
      try {
        return await run(span);
      } catch (error) {
        recordFailure(span, error);
        throw error;
      } finally {
        span.end();
        finish();
      }
    });
}
