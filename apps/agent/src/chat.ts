import { chatInputSchema, chatResponseSchema } from "@home-agent/api/contracts";
import { AppError } from "@home-agent/api/errors";
import type { z } from "zod";
import type { createAssistant } from "./assistant";

export function createChat(assistant: ReturnType<typeof createAssistant>) {
  if (!assistant) return undefined;
  return async (
    input: z.infer<typeof chatInputSchema>,
    requestSignal: AbortSignal,
  ) => {
    try {
      const answer = await assistant.run(input.message, requestSignal);
      requestSignal.throwIfAborted();
      return chatResponseSchema.parse({ answer });
    } catch (cause) {
      throw new AppError(
        requestSignal.aborted
          ? "request_cancelled"
          : cause instanceof DOMException && cause.name === "TimeoutError"
            ? "run_timeout"
            : "agent_execution_failed",
        { cause },
      );
    }
  };
}
