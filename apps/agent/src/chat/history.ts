import type { z } from "zod";
import {
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
import { messageText, checkpointMessages, canContinueChat } from "./state";

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
      signal.throwIfAborted();
      const result = await database.threads.list(input);
      signal.throwIfAborted();
      return {
        ...result,
        threads: result.threads.map((thread) => ({
          ...thread,
          running: activeThreads.has(thread.threadId),
        })),
      };
    },
    async detail(input: z.infer<typeof chatHistoryInputSchema>) {
      const saved = await read(input.threadId, input.checkpointId);
      const messages = checkpointMessages(saved);
      const boundaries = messages.flatMap((message, index) =>
        isHumanMessage(message) ? [index] : [],
      );
      const end = Math.min(
        input.before ?? boundaries.length,
        boundaries.length,
      );
      const start = Math.max(0, end - input.limit);
      const turns: z.infer<typeof chatTurnSchema>[] = [];
      for (const message of messages.slice(
        boundaries[start] ?? messages.length,
        boundaries[end] ?? messages.length,
      )) {
        if (isHumanMessage(message)) {
          turns.push({
            id: message.id ?? `${saved.checkpoint.id}:${start + turns.length}`,
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
      const running = activeThreads.has(input.threadId);
      return {
        threadId: input.threadId,
        checkpointId: saved.checkpoint.id,
        turns,
        nextBefore: start > 0 ? start : null,
        canContinue: !running && canContinueChat(saved),
        running,
      };
    },
  };
}
