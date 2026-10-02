import {
  createChatHistory,
  canContinueChat,
  messageText,
} from "../chat/history";
import { createHouseholdReset } from "../household-reset";
import type { RunFailedEvent } from "@home-agent/api/contracts";
import { AppError, errorPayload } from "@home-agent/api/errors";
import { errorResponse, validateJson } from "@home-agent/api/errors/hono";
import {
  context,
  withSpan,
  recordFailure,
  currentTraceId,
} from "@home-agent/observability";
import { HumanMessage, isToolMessage } from "@langchain/core/messages";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import {
  agentChatInputSchema,
  chatToolNameSchema,
  chatToolPreviewLimit,
  chatHistoryListInputSchema,
  chatHistoryListSchema,
  chatHistoryInputSchema,
  chatHistorySchema,
  chatHistoryResponseBytes,
} from "@home-agent/api/contracts";
import type { createHomeAgent } from "../graph/home-agent";
import type { AgentDatabase } from "../db";

export function createChatRoutes(
  agent: ReturnType<typeof createHomeAgent>,
  timeoutMs: number,
  database?: AgentDatabase,
  reset = createHouseholdReset(database),
) {
  const app = new Hono();
  // Single-process admission guard. Hold until graph execution has settled.
  const activeThreads = new Set<string>();
  async function readHistory<T>(
    operation: (history: ReturnType<typeof createChatHistory>) => Promise<T>,
    signal: AbortSignal,
  ) {
    if (!database) throw new AppError("database_not_configured");
    const leave = reset.enter();
    try {
      const result = await operation(
        createChatHistory(database, activeThreads, signal),
      );
      if (Buffer.byteLength(JSON.stringify(result)) > chatHistoryResponseBytes)
        throw new AppError("request_too_large");
      return result;
    } catch (cause) {
      if (signal.aborted) throw new AppError("request_cancelled");
      if (cause instanceof AppError) throw cause;
      throw new AppError("persistence_unavailable", { cause });
    } finally {
      leave();
    }
  }
  app.use(
    "/history/*",
    bodyLimit({
      maxSize: 4096,
      onError: (c) => errorResponse(c, new AppError("request_too_large")),
    }),
  );
  app.post(
    "/history/list",
    validateJson(chatHistoryListInputSchema),
    async (c) =>
      c.json(
        chatHistoryListSchema.parse(
          await readHistory(
            (history) => history.list(c.req.valid("json")),
            c.req.raw.signal,
          ),
        ),
      ),
  );
  app.post("/history/read", validateJson(chatHistoryInputSchema), async (c) =>
    c.json(
      chatHistorySchema.parse(
        await readHistory(
          (history) => history.detail(c.req.valid("json")),
          c.req.raw.signal,
        ),
      ),
    ),
  );
  app.post(
    "/",
    bodyLimit({
      // The backend adds the trusted household scope to the public 32 KiB body.
      maxSize: 33_792,
      onError: (c) =>
        errorResponse(
          c,
          new AppError("request_too_large", { params: { maxBytes: 33792 } }),
        ),
    }),
    validateJson(agentChatInputSchema),
    async (c) => {
      const input = c.req.valid("json");
      if (!agent) throw new AppError("model_not_configured");
      if (!database) throw new AppError("database_not_configured");
      const threadId = input.threadId ?? crypto.randomUUID();
      if (activeThreads.has(threadId))
        throw new AppError("thread_busy", { params: { threadId } });
      const leave = reset.enter();
      activeThreads.add(threadId);
      try {
        // Check storage before returning an SSE success status or calling the model.
        const saved = await database.checkpointer.getTuple({
          configurable: { thread_id: threadId },
        });
        if (input.threadId && !saved) throw new AppError("not_found");
        if (!canContinueChat(saved)) throw new AppError("thread_incomplete");
      } catch (cause) {
        activeThreads.delete(threadId);
        leave();
        if (cause instanceof AppError) throw cause;
        throw new AppError("persistence_unavailable", { cause });
      }
      if (c.req.raw.signal.aborted) {
        activeThreads.delete(threadId);
        leave();
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
                      configurable: {
                        thread_id: threadId,
                        household_scope: input.household_scope,
                      },
                      durability: "sync",
                    },
                  )) {
                    const toolName = chatToolNameSchema.safeParse(event.name);
                    if (toolName.success && event.event === "on_tool_start") {
                      await emit("tool_started", {
                        runId,
                        threadId,
                        callId: event.run_id,
                        name: toolName.data,
                        input: event.data.input,
                      });
                    }
                    if (toolName.success && event.event === "on_tool_end") {
                      const output: unknown = event.data.output;
                      const content = messageText(
                        isToolMessage(output) ? output.content : output,
                      );
                      await emit("tool_completed", {
                        runId,
                        threadId,
                        callId: event.run_id,
                        name: toolName.data,
                        output: content.slice(0, chatToolPreviewLimit),
                        truncated: content.length > chatToolPreviewLimit,
                      });
                    }
                    if (event.event === "on_chat_model_stream") {
                      const text = messageText(event.data.chunk?.content);
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
          .finally(() => {
            activeThreads.delete(threadId);
            leave();
          }),
      );
      response.headers.set("Cache-Control", "no-cache, no-transform");
      return response;
    },
  );

  return app;
}
