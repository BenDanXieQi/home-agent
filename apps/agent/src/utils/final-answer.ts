import { contentText, type AssistantMessage } from "@earendil-works/pi-ai";

export function readFinalAnswer(message: AssistantMessage | undefined) {
  if (
    !message ||
    message.stopReason !== "stop" ||
    message.content.some((block) => block.type === "toolCall")
  )
    throw new Error("The agent did not produce a complete final answer");
  const answer = contentText(message.content, "");
  if (!answer.trim()) throw new Error("The agent produced an empty answer");
  return answer;
}
