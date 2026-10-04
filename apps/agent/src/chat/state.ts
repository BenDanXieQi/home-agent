import { isBaseMessage, isAIMessage } from "@langchain/core/messages";
import { AppError } from "@home-agent/api/errors";
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

export function checkpointMessages(
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
