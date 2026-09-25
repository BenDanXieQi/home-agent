import { chatInputSchema } from "@home-agent/api/contracts";
import { AppError } from "@home-agent/api/errors";
import { errorResponse, validateJson } from "@home-agent/api/errors/hono";
import { tracedFetch } from "@home-agent/observability";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireLocalAccess } from "@home-agent/api/local-access";

export type ChatDependencies = {
  port: number;
  timeoutMs: number;
  readAgentUrl: () => Promise<string>;
};

export function createChatRoutes({
  port,
  timeoutMs,
  readAgentUrl,
}: ChatDependencies) {
  const app = new Hono();
  app.use(requireLocalAccess([port, 5173]));
  const routes = app.post(
    "/",
    bodyLimit({
      maxSize: 32_768,
      onError: (c) =>
        errorResponse(
          c,
          new AppError("request_too_large", { params: { maxBytes: 32768 } }),
        ),
    }),
    validateJson(chatInputSchema),
    async (c) => {
      // Keep this request's address even if the file changes during its stream.
      const agentUrl = await readAgentUrl();
      const input = c.req.valid("json");

      const disconnected = new AbortController();
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([
        c.req.raw.signal,
        disconnected.signal,
        timeout,
      ]);

      let upstream: Response;
      try {
        upstream = await tracedFetch(new URL("/api/chat", agentUrl), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify(input),
          signal,
        });
      } catch (cause) {
        throw new AppError(
          c.req.raw.signal.aborted
            ? "request_cancelled"
            : timeout.aborted
              ? "agent_timeout"
              : "agent_unavailable",
          { cause },
        );
      }

      const headers = new Headers();
      for (const name of [
        "content-type",
        "cache-control",
        "x-accel-buffering",
        "x-thread-id",
      ]) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
      }

      // Forward bytes unchanged. Cancellation must reach both the response body
      // and Bun's fetch signal so an abandoned SSE request stops the agent.
      const reader = upstream.body?.getReader();
      const body = reader
        ? new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const { done, value } = await reader.read();
                if (done) {
                  controller.close();
                  reader.releaseLock();
                } else {
                  controller.enqueue(value);
                }
              } catch {
                disconnected.abort();
                controller.error(
                  new Error("Agent response stream interrupted"),
                );
                reader.releaseLock();
              }
            },
            async cancel(reason) {
              disconnected.abort();
              try {
                await reader.cancel(reason);
              } finally {
                reader.releaseLock();
              }
            },
          })
        : null;
      return new Response(body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    },
  );
  return routes;
}
