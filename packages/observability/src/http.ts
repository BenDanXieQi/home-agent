import { httpInstrumentationMiddleware } from "@hono/otel";
import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";
import { createMiddleware } from "hono/factory";
import type { HonoRequest } from "hono";
import { routePath } from "hono/route";
import { telemetryStatus } from "./telemetry";
import { beginOperation } from "./lifecycle";
import { currentTraceId, recordFailure } from "./spans";
import { agentTraceContext, withAgentTrace } from "./agent-trace";
import {
  currentTraceSessionId,
  requestSession,
  sessionBaggageContext,
  sessionResponseHeader,
  traceSessionId,
  withRequestSession,
} from "./session";

export function httpTracing(
  service: string,
  isAgentExecution: (
    request: Pick<HonoRequest, "method" | "path">,
  ) => boolean = () => false,
) {
  const instrument = httpInstrumentationMiddleware({
    captureActiveRequests: false,
    spanNameFactory: (c) => `${service} 接收: ${c.req.method} ${routePath(c)}`,
  });
  return createMiddleware(async (c, next) => {
    let originalError: Error | undefined;
    try {
      await instrument(c, async () => {
        const execution = isAgentExecution(c.req);
        await withRequestSession(!execution, async (session) => {
          const url = new URL(c.req.url);
          trace
            .getActiveSpan()
            ?.setAttribute("url.full", `${url.origin}${url.pathname}`);
          const traceId = currentTraceId();
          if (execution) await withAgentTrace(next);
          else await next();
          if (traceId) c.header("x-trace-id", traceId);
          if (service === "agent" && session.id)
            c.header(sessionResponseHeader, session.id);
          originalError = c.error;
          if (c.error && !telemetryStatus().includeContent) {
            const safeError = new Error("Request failed");
            delete safeError.stack;
            c.error = safeError;
          }
        });
      });
    } finally {
      if (originalError) c.error = originalError;
    }
  });
}

export function tracedFetch(
  direction: { from: string; to: string },
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) {
  const request =
    input instanceof Request
      ? new Request(input, init)
      : new Request(input.toString(), init);
  const url = new URL(request.url);
  const method = request.method;
  const caller = context.active();
  const session = requestSession(caller);
  const internal =
    (direction.from === "agent" && direction.to === "backend") ||
    (direction.from === "backend" && direction.to === "agent");
  return trace.getTracer("home-agent.http").startActiveSpan(
    `${direction.from} → ${direction.to}: ${method} ${url.pathname}`,
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
        propagation.inject(
          sessionBaggageContext(
            agentTraceContext(context.active()),
            internal ? currentTraceSessionId() : undefined,
          ),
          carrier,
        );
        const headers = new Headers(request.headers);
        headers.delete("baggage");
        for (const [key, value] of Object.entries(carrier))
          headers.set(key, value);
        const response = await fetch(request, { headers });
        if (!ended) {
          if (internal && direction.to === "agent") {
            const id = traceSessionId(
              response.headers.get(sessionResponseHeader),
            );
            const known = currentTraceSessionId(caller);
            if (id && (known === undefined || known === id)) {
              span.setAttribute("session.id", id);
              session?.bind(id);
            }
          }
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
