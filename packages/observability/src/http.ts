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
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const url = new URL(input);
  const method = init.method ?? "GET";
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
        init.signal?.removeEventListener("abort", onAbort);
        span.end();
        finishOperation();
      };
      const onAbort = () => {
        span.setAttribute("operation.cancelled", true);
        recordFailure(span, init.signal?.reason);
        finish();
      };
      if (init.signal?.aborted) onAbort();
      else init.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const carrier: Record<string, string> = {};
        propagation.inject(context.active(), carrier);
        const headers = new Headers(init.headers);
        for (const [key, value] of Object.entries(carrier))
          headers.set(key, value);
        const response = await fetch(url, { ...init, headers });
        span.setAttribute("http.response.status_code", response.status);
        if (response.status >= 400)
          span.setStatus({ code: SpanStatusCode.ERROR });
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
              recordFailure(span, error);
              finish();
              controller.error(error);
            }
          },
          async cancel(reason) {
            span.setAttribute("operation.cancelled", true);
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
        recordFailure(span, error);
        finish();
        throw error;
      }
    },
  );
}
