import type { RunFailedEvent } from "@home-agent/api/contracts";
import { AppError, errorPayload } from "@home-agent/api/errors";
import { errorResponse, validateJson } from "@home-agent/api/errors/hono";
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
import { chatInputSchema } from "@home-agent/api/contracts";
import type { createHomeAgent } from "../graph/home-agent";
import type { AgentDatabase } from "../db";

function textContent(content: unknown) {
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
        errorResponse(
          c,
          new AppError("request_too_large", { params: { maxBytes: 32768 } }),
        ),
    }),
    validateJson(chatInputSchema),
    async (c) => {
      const input = c.req.valid("json");
      if (!agent) throw new AppError("model_not_configured");
      if (!database) throw new AppError("database_not_configured");
      const threadId = input.threadId ?? crypto.randomUUID();
      if (activeThreads.has(threadId))
        throw new AppError("thread_busy", { params: { threadId } });
      activeThreads.add(threadId);
      try {
        // Check storage before returning an SSE success status or calling the model.
        await database.checkpointer.getTuple({
          configurable: { thread_id: threadId },
        });
      } catch (cause) {
        activeThreads.delete(threadId);
        throw new AppError("persistence_unavailable", { cause });
      }
      if (c.req.raw.signal.aborted) {
        activeThreads.delete(threadId);
        throw new AppError("request_cancelled");
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
                            error: errorPayload(
                              new AppError("run_timeout", {
                                params: { timeoutMs },
                              }),
                              currentTraceId(),
                            ),
                          } satisfies RunFailedEvent),
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
                    { messages: [new HumanMessage(input.message)] },
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
                      error: errorPayload(
                        new AppError("agent_execution_failed"),
                        currentTraceId(),
                      ),
                    } satisfies RunFailedEvent);
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
