import {
  trace,
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  type Span,
  type Attributes,
} from "@opentelemetry/api";
import { beginOperation } from "./lifecycle";
import { telemetryStatus } from "./telemetry";

export {
  context,
  ROOT_CONTEXT,
  trace,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";

export function currentTraceId() {
  const id = trace.getActiveSpan()?.spanContext().traceId;
  return id && id !== "00000000000000000000000000000000" ? id : undefined;
}

/** Call only after access to the internal endpoint has been checked. */
export function withRequestSpan(
  request: Request,
  run: () => Promise<Response>,
) {
  const parent = propagation.extract(ROOT_CONTEXT, {
    traceparent: request.headers.get("traceparent") ?? undefined,
    tracestate: request.headers.get("tracestate") ?? undefined,
  });
  const path = new URL(request.url).pathname;
  return context.with(parent, () =>
    withSpan(
      `${request.method} ${path}`,
      { "http.request.method": request.method, "http.route": path },
      async (span) => {
        const response = await run();
        span.setAttribute("http.response.status_code", response.status);
        if (response.status >= 400)
          span.setStatus({ code: SpanStatusCode.ERROR });
        const id = currentTraceId();
        if (id) response.headers.set("x-trace-id", id);
        return response;
      },
      { kind: SpanKind.SERVER },
    ),
  );
}

export function recordFailure(span: Span, error: unknown, errorType?: string) {
  if (!span.isRecording()) return;
  if (error instanceof Error && error.name === "AbortError") {
    span.setAttribute("operation.cancelled", true);
    return;
  }
  const type =
    errorType ??
    (error instanceof Error && error.name === "TimeoutError"
      ? "timeout"
      : "Error");
  // Error messages from model providers may contain prompts or credentials.
  const message =
    telemetryStatus().includeContent && error instanceof Error
      ? error.message
      : "Operation failed";
  span.setAttribute("error.type", type);
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
  options: {
    kind?: SpanKind;
    onError?: (span: Span, error: unknown) => void;
  } = {},
) {
  return trace
    .getTracer("home-agent")
    .startActiveSpan(
      name,
      { attributes, kind: options.kind ?? SpanKind.INTERNAL },
      async (span) => {
        const finish = beginOperation();
        try {
          return await run(span);
        } catch (error) {
          if (span.isRecording())
            (options.onError ?? recordFailure)(span, error);
          throw error;
        } finally {
          span.end();
          finish();
        }
      },
    );
}
