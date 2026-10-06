import { AIMessage } from "@langchain/core/messages";
import { chatInputSchema, chatResponseSchema } from "@home-agent/api/contracts";
import { AppError } from "@home-agent/api/errors";
import type { z } from "zod";
import type { createAssistant } from "./assistant";
import type { Config } from "./config";

export function createChat(
  assistant: ReturnType<typeof createAssistant>,
  config: Pick<Config, "AGENT_RUN_TIMEOUT_MS">,
) {
  if (!assistant) return undefined;
  return async (
    input: z.infer<typeof chatInputSchema>,
    requestSignal: AbortSignal,
  ) => {
    const timeout = AbortSignal.timeout(config.AGENT_RUN_TIMEOUT_MS);
    const signal = AbortSignal.any([requestSignal, timeout]);
    try {
      const result = await assistant.invoke(
        { messages: [{ role: "user", content: input.message }] },
        { signal, recursionLimit: 30 },
      );
      signal.throwIfAborted();
      const answer = result.messages.at(-1);
      if (
        !answer ||
        !AIMessage.isInstance(answer) ||
        answer.tool_calls?.length ||
        answer.invalid_tool_calls?.length ||
        answer.response_metadata.finish_reason === "length" ||
        answer.response_metadata.finish_reason === "content_filter" ||
        answer.response_metadata.status === "incomplete" ||
        answer.response_metadata.status === "failed"
      )
        throw new AppError("agent_execution_failed");
      return chatResponseSchema.parse({ answer: answer.text });
    } catch (cause) {
      throw new AppError(
        requestSignal.aborted
          ? "request_cancelled"
          : timeout.aborted
            ? "run_timeout"
            : "agent_execution_failed",
        { cause },
      );
    }
  };
}
