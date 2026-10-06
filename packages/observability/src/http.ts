import { httpInstrumentationMiddleware } from "@hono/otel";
import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";
import { createMiddleware } from "hono/factory";
import { telemetryStatus } from "./telemetry";
import { beginOperation } from "./lifecycle";
import { currentTraceId, recordFailure } from "./spans";

export function httpTracing() {
  const instrument = httpInstrumentationMiddleware({
    captureActiveRequests: false,
  });
  return createMiddleware(async (c, next) => {
    let originalError: Error | undefined;
    try {
      await instrument(c, async () => {
        const url = new URL(c.req.url);
        trace
          .getActiveSpan()
          ?.setAttribute("url.full", `${url.origin}${url.pathname}`);
        const traceId = currentTraceId();
        await next();
        if (traceId) c.header("x-trace-id", traceId);
        originalError = c.error;
        // @hono/otel records c.error after next(), including its stack.
        if (c.error && !telemetryStatus().includeContent) {
          const safeError = new Error("Request failed");
          delete safeError.stack;
          c.error = safeError;
        }
      });
    } finally {
      if (originalError) c.error = originalError;
    }
  });
}

/** CLIENT span covers headers AND body consumption, including SSE and cancellation. */
export function tracedFetch(
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
) {
  const request =
    input instanceof Request
      ? new Request(input, init)
      : new Request(input.toString(), init);
  const url = new URL(request.url);
  const method = request.method;
  return trace.getTracer("home-agent.http").startActiveSpan(
    `${method} ${url.pathname}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "http.request.method": method,
        "url.full": `${url.origin}${url.pathname}`,
        "server.address": url.hostname,
      },
    },
    async (span) => {
      const finishOperation = beginOperation();
      let ended = false;
      const finish = () => {
        if (ended) return;
        ended = true;
        request.signal.removeEventListener("abort", onAbort);
        span.end();
        finishOperation();
      };
      const recordCancellation = (reason: unknown) => {
        if (ended) return;
        if (reason instanceof Error && reason.name === "TimeoutError")
          recordFailure(span, reason, "timeout");
        else span.setAttribute("operation.cancelled", true);
      };
      const onAbort = () => {
        recordCancellation(request.signal.reason);
        finish();
      };
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const carrier: Record<string, string> = {};
        propagation.inject(context.active(), carrier);
        const headers = new Headers(request.headers);
        for (const [key, value] of Object.entries(carrier))
          headers.set(key, value);
        const response = await fetch(request, { headers });
        if (!ended) {
          span.setAttribute("http.response.status_code", response.status);
          if (response.status >= 400) {
            span.setAttribute("error.type", String(response.status));
            span.setStatus({ code: SpanStatusCode.ERROR });
          }
        }
        if (!response.body) {
          finish();
          return response;
        }
        const reader = response.body.getReader();
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                finish();
                controller.close();
              } else controller.enqueue(value);
            } catch (error) {
              if (!ended) recordFailure(span, error);
              finish();
              controller.error(error);
            }
          },
          async cancel(reason) {
            recordCancellation(reason);
            try {
              await reader.cancel(reason);
            } finally {
              finish();
            }
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        if (!ended) recordFailure(span, error);
        finish();
        throw error;
      }
    },
  );
}
