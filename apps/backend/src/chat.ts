import { tracedFetch } from "@home-agent/observability";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Config } from "./config";
import type { AppEnv } from "./env";

export function createChatRoutes(config: Config) {
  const app = new Hono<AppEnv>();
  app.post(
    "/",
    bodyLimit({
      maxSize: 32_768,
      onError: (c) =>
        c.json(
          {
            error: "request_too_large",
            message: "Maximum body size is 32 KiB",
          },
          413,
        ),
    }),
    async (c) => {
      const contentType = c.req.header("content-type")?.split(";")[0]?.trim();
      if (contentType?.toLowerCase() !== "application/json") {
        return c.json(
          { error: "content_type_required", message: "Use application/json" },
          415,
        );
      }
      let input: unknown;
      try {
        input = await c.req.json();
      } catch {
        return c.json(
          { error: "invalid_request", message: "Provide a valid JSON body" },
          400,
        );
      }

      const disconnected = new AbortController();
      const timeout = AbortSignal.timeout(config.BACKEND_REQUEST_TIMEOUT_MS);
      const signal = AbortSignal.any([
        c.req.raw.signal,
        disconnected.signal,
        timeout,
      ]);

      let upstream: Response;
      try {
        upstream = await tracedFetch(
          new URL("/api/chat", config.AGENT_BASE_URL),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            body: JSON.stringify(input),
            signal,
          },
        );
      } catch {
        return c.json(
          timeout.aborted
            ? { error: "agent_timeout", message: "The agent request timed out" }
            : {
                error: "agent_unavailable",
                message: "The agent could not be reached",
              },
          timeout.aborted ? 504 : 502,
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
  return app;
}
