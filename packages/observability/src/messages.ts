import type { TranscriptContext } from "@earendil-works/pi-ai";

export function serializeModelInput(input: unknown) {
  return JSON.stringify(input, function (this: unknown, key, value: unknown) {
    if (
      key === "video_url" &&
      typeof value === "object" &&
      value !== null &&
      "url" in value &&
      typeof value.url === "string" &&
      value.url.startsWith("data:;base64,")
    )
      return { ...value, url: value.url.replace("data:;", "data:video/mp4;") };
    if (typeof value !== "string" || typeof this !== "object" || this === null)
      return value;
    if (key !== "data") return value;

    const mimeType =
      "mimeType" in this && typeof this.mimeType === "string"
        ? this.mimeType
        : "media_type" in this && typeof this.media_type === "string"
          ? this.media_type
          : "format" in this && typeof this.format === "string"
            ? `audio/${this.format === "m4a" ? "mp4" : this.format === "mp3" ? "mpeg" : this.format}`
            : undefined;
    if (!mimeType) return value;
    if (
      value.startsWith("data:;base64,") ||
      value.startsWith("data:audio/m4a;base64,")
    )
      return value.replace(/^data:[^;]*;/, `data:${mimeType};`);
    if (value.startsWith("data:")) return value;
    return `data:${mimeType};base64,${value}`;
  });
}

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
