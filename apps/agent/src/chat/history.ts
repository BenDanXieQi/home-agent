import { z } from "zod";
import {
  isBaseMessage,
  isHumanMessage,
  isAIMessage,
  isToolMessage,
} from "@langchain/core/messages";
import { AppError } from "@home-agent/api/errors";
import {
  chatToolNameSchema,
  chatToolPreviewLimit,
  chatTurnSchema,
  type chatHistoryInputSchema,
  type chatHistoryListInputSchema,
} from "@home-agent/api/contracts";
import type { AgentDatabase } from "../db";

export function messageText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) =>
      typeof block === "object" &&
      block !== null &&
      "text" in block &&
      typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("");
}

function checkpointMessages(
  saved: NonNullable<
    Awaited<ReturnType<AgentDatabase["checkpointer"]["getTuple"]>>
  >,
) {
  const values: unknown = saved.checkpoint.channel_values.messages;
  if (values === undefined) return [];
  if (!Array.isArray(values) || !values.every(isBaseMessage))
    throw new AppError("persistence_unavailable");
  return values;
}
export function canContinueChat(
  saved: Awaited<ReturnType<AgentDatabase["checkpointer"]["getTuple"]>>,
) {
  if (!saved) return true;
  const last = checkpointMessages(saved).at(-1);
  return (
    saved.metadata?.source === "loop" &&
    !saved.pendingWrites?.length &&
    !!last &&
    isAIMessage(last) &&
    !last.tool_calls?.length &&
    !last.invalid_tool_calls?.length
  );
}

export function createChatHistory(
  database: AgentDatabase,
  activeThreads: Set<string>,
  signal: AbortSignal,
) {
  async function read(threadId: string, checkpointId?: string) {
    signal.throwIfAborted();
    const saved = await database.checkpointer.getTuple({
      configurable: {
        thread_id: threadId,
        checkpoint_ns: "",
        ...(checkpointId ? { checkpoint_id: checkpointId } : {}),
      },
    });
    signal.throwIfAborted();
    if (!saved) throw new AppError("not_found");
    return saved;
  }
  return {
    async list(input: z.infer<typeof chatHistoryListInputSchema>) {
      // Only enumerate root checkpoint identities here. The official saver owns message decoding.
      const result = await database.pool.query(
        `
        SELECT thread_id, checkpoint_id FROM (
          SELECT DISTINCT ON (thread_id) thread_id, checkpoint_id
          FROM agent_state.checkpoints WHERE checkpoint_ns = ''
          ORDER BY thread_id, checkpoint_id DESC
        ) latest
        WHERE ($1::text IS NULL OR checkpoint_id < $1)
        ORDER BY checkpoint_id DESC LIMIT $2`,
        [input.before ?? null, input.limit + 1],
      );
      signal.throwIfAborted();
      const rows = z
        .array(z.object({ thread_id: z.uuid(), checkpoint_id: z.uuid() }))
        .parse(result.rows);
      const page = rows.slice(0, input.limit);
      const threads = [];
      for (const row of page) {
        const saved = await read(row.thread_id, row.checkpoint_id);
        const first = checkpointMessages(saved).find(isHumanMessage);
        threads.push({
          threadId: row.thread_id,
          title: first
            ? messageText(first.content).replace(/\s+/g, " ").slice(0, 80) ||
              "新对话"
            : "未完成的对话",
          updatedAt: saved.checkpoint.ts,
          running: activeThreads.has(row.thread_id),
        });
      }
      return {
        threads,
        nextBefore:
          rows.length > input.limit
            ? (page.at(-1)?.checkpoint_id ?? null)
            : null,
      };
    },
    async detail(input: z.infer<typeof chatHistoryInputSchema>) {
      const saved = await read(input.threadId, input.checkpointId);
      const turns: z.infer<typeof chatTurnSchema>[] = [];
      for (const message of checkpointMessages(saved)) {
        if (isHumanMessage(message)) {
          turns.push({
            id: message.id ?? `${saved.checkpoint.id}:${turns.length}`,
            message: messageText(message.content),
            answer: "",
            tools: [],
            runId: "",
            error: "",
            status: "incomplete",
          });
          continue;
        }
        const turn = turns.at(-1);
        if (!turn) continue;
        if (isAIMessage(message)) {
          turn.answer += messageText(message.content);
          for (const call of message.tool_calls ?? []) {
            const name = chatToolNameSchema.safeParse(call.name);
            if (name.success && call.id)
              turn.tools.push({
                callId: call.id,
                name: name.data,
                input: call.args,
                output: null,
                truncated: false,
              });
          }
          if (
            !message.tool_calls?.length &&
            !message.invalid_tool_calls?.length
          )
            turn.status = "completed";
        } else if (isToolMessage(message)) {
          const call = turn.tools.find(
            (item) => item.callId === message.tool_call_id,
          );
          if (call) {
            const text = messageText(message.content);
            call.output = text.slice(0, chatToolPreviewLimit);
            call.truncated = text.length > chatToolPreviewLimit;
          }
        }
      }
      const end = Math.min(input.before ?? turns.length, turns.length);
      const start = Math.max(0, end - input.limit);
      const running = activeThreads.has(input.threadId);
      return {
        threadId: input.threadId,
        checkpointId: saved.checkpoint.id,
        turns: turns.slice(start, end),
        nextBefore: start > 0 ? start : null,
        canContinue: !running && canContinueChat(saved),
        running,
      };
    },
  };
}
