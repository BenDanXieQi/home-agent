import type { TranscriptContext } from "@earendil-works/pi-ai";

function genAiParts(content: TranscriptContext["messages"][number]["content"]) {
  if (typeof content === "string") return [{ type: "text" as const, content }];
  return content.map((part) => {
    switch (part.type) {
      case "text":
        return { type: "text" as const, content: part.text };
      case "thinking":
        return { type: "reasoning" as const, content: part.thinking };
      case "toolCall":
        return {
          type: "tool_call" as const,
          id: part.id,
          name: part.name,
          arguments: part.arguments,
        };
    }
    return {
      type: "blob" as const,
      modality: "image" as const,
      mime_type: part.mimeType,
      content: part.data,
    };
  });
}

export function genAiMessages(
  messages: readonly TranscriptContext["messages"][number][],
) {
  return messages.map((message) => {
    if (message.role === "toolResult")
      return {
        role: "tool" as const,
        name: message.toolName,
        parts: [
          {
            type: "tool_call_response" as const,
            id: message.toolCallId,
            response: genAiParts(message.content),
          },
        ],
      };
    return {
      role: message.role,
      parts: genAiParts(message.content),
      ...(message.role === "system" && message.sections
        ? { sections: message.sections }
        : {}),
    };
  });
}
