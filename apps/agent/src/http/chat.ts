import {
  context,
  withSpan,
  recordFailure,
  currentTraceId,
} from "@home-agent/observability";
import { HumanMessage } from "@langchain/core/messages";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { createHomeAgent } from "../graph/home-agent";
import type { AgentDatabase } from "../db";

const chatInput = z
  .object({
    message: z.string().trim().min(1).max(16_000),
    threadId: z
      .uuid()
      .transform((id) => id.toLowerCase())
      .optional(),
  })
  .strict();

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => {
      if (typeof block !== "object" || block === null || !("text" in block))
        return "";
      return typeof block.text === "string" ? block.text : "";
    })
    .join("");
}

export function createChatRoutes(
  agent: ReturnType<typeof createHomeAgent>,
  timeoutMs: number,
  database?: AgentDatabase,
) {
  const app = new Hono();
  // Single-process admission guard. Hold until graph execution has settled.
  const activeThreads = new Set<string>();
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
      if (
        c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json"
      ) {
        return c.json(
          { error: "content_type_required", message: "Use application/json" },
          415,
        );
      }
      const input = chatInput.safeParse(
        await c.req.json().catch(() => undefined),
      );
      if (!input.success)
        return c.json(
          {
            error: "invalid_request",
            message:
              "Provide a message of 1–16000 characters and an optional UUID threadId",
          },
          400,
        );
      if (!agent)
        return c.json(
          {
            error: "model_not_configured",
            message: "Set AGENT_MODEL and OPENAI_API_KEY to enable chat",
          },
          503,
        );

      if (!database)
        return c.json(
          {
            error: "database_not_configured",
            message:
              "Set AGENT_DATABASE_URL or DATABASE_URL and run db:agent:setup",
          },
          503,
        );
      const threadId = input.data.threadId ?? crypto.randomUUID();
      if (activeThreads.has(threadId))
        return c.json({ error: "thread_busy", threadId }, 409);
      activeThreads.add(threadId);
      try {
        // Check storage before returning an SSE success status or calling the model.
        await database.checkpointer.getTuple({
          configurable: { thread_id: threadId },
        });
      } catch {
        activeThreads.delete(threadId);
        return c.json(
          {
            error: "persistence_unavailable",
            message: "Check the database and run db:agent:setup",
          },
          503,
        );
      }
      if (c.req.raw.signal.aborted) {
        activeThreads.delete(threadId);
        return new Response(null, { status: 499 });
      }
      const runId = crypto.randomUUID();
      c.header("X-Thread-Id", threadId);
      c.header("X-Accel-Buffering", "no");
      const parent = context.active();
      const response = streamSSE(c, (stream) =>
        context
          .with(parent, () =>
            withSpan(
              "agent.run",
              {
                "langsmith.span.kind": "chain",
                "langsmith.metadata.run_id": runId,
                "langsmith.metadata.thread_id": threadId,
              },
              async (span) => {
                const disconnected = new AbortController();
                stream.onAbort(() => disconnected.abort());
                const timeout = AbortSignal.timeout(timeoutMs);
                let timeoutNotification: Promise<void> | undefined;
                let terminalQueued = false;
                const signal = AbortSignal.any([
                  c.req.raw.signal,
                  disconnected.signal,
                  timeout,
                ]);
                const onAbort = () => {
                  span.setAttribute("operation.cancelled", true);
                  recordFailure(span, signal.reason);
                  if (c.req.raw.signal.aborted || disconnected.signal.aborted) {
                    stream.abort();
                    return;
                  }
                  // Notify a connected client immediately, independently of how
                  // quickly the model/database settles after cancellation.
                  timeoutNotification = (async () => {
                    const closeTimer = setTimeout(() => stream.abort(), 1_000);
                    try {
                      if (!terminalQueued) {
                        terminalQueued = true;
                        await stream.writeSSE({
                          event: "run_failed",
                          data: JSON.stringify({
                            runId,
                            threadId,
                            error: "run_aborted_or_timed_out",
                          }),
                        });
                      }
                      await stream.close();
                    } catch {
                      stream.abort();
                    } finally {
                      clearTimeout(closeTimer);
                    }
                  })();
                };
                if (signal.aborted) onAbort();
                else signal.addEventListener("abort", onAbort, { once: true });
                const emit = async (event: string, data: unknown) => {
                  if (!stream.aborted && !signal.aborted && !terminalQueued) {
                    if (event === "run_completed" || event === "run_failed")
                      terminalQueued = true;
                    await stream.writeSSE({
                      event,
                      data: JSON.stringify(data),
                    });
                  }
                };
                try {
                  const start = performance.now();
                  let firstToken = true;
                  await emit("run_started", {
                    runId,
                    threadId,
                    traceId: currentTraceId(),
                    persistent: true,
                  });
                  for await (const event of agent.graph.streamEvents(
                    { messages: [new HumanMessage(input.data.message)] },
                    {
                      version: "v2",
                      runId,
                      runName: "home-agent-chat",
                      recursionLimit: 12,
                      signal,
                      configurable: { thread_id: threadId },
                      durability: "sync",
                    },
                  )) {
                    if (event.event === "on_chat_model_stream") {
                      const text = textContent(event.data.chunk?.content);
                      if (text) {
                        if (firstToken) {
                          span.setAttribute(
                            "agent.time_to_first_token_ms",
                            performance.now() - start,
                          );
                          firstToken = false;
                        }
                        await emit("token", { text });
                      }
                    }
                  }
                  signal.throwIfAborted();
                  await emit("run_completed", { runId, threadId });
                } catch (error) {
                  if (!signal.aborted) {
                    recordFailure(span, error);
                    await emit("run_failed", {
                      runId,
                      threadId,
                      error: "agent_execution_failed",
                    });
                  }
                } finally {
                  signal.removeEventListener("abort", onAbort);
                  await timeoutNotification;
                }
              },
            ),
          )
          .finally(() => activeThreads.delete(threadId)),
      );
      response.headers.set("Cache-Control", "no-cache, no-transform");
      return response;
    },
  );

  return app;
}
