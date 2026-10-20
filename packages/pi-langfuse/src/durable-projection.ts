import { ToolResultEntry, type EntryRecord } from "@earendil-works/pi-durable";
import { sanitizeTraceValue } from "./sanitizer.js";
import type { ObservationAttributes } from "./tracing.js";

type Message = NonNullable<EntryRecord["model"]>[number];

export function durableAttributes(attributes: ObservationAttributes) {
  const copy = { ...attributes };
  if (attributes.metadata) {
    const value = sanitizeTraceValue(attributes.metadata, true);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new TypeError("Trace metadata must serialize to a JSON object");
    const entries: [string, unknown][] = Object.entries(value);
    copy.metadata = Object.fromEntries(entries);
  }
  for (const key of [
    "name",
    "model",
    "sessionId",
    "userId",
    "statusMessage",
    "version",
  ] as const) {
    if (typeof copy[key] === "string")
      copy[key] = String(sanitizeTraceValue(copy[key], true));
  }
  return copy;
}

export function durableToolDiagnostics(entry: EntryRecord | undefined) {
  return entry && ToolResultEntry.is(entry) ? entry.data.diagnostics : [];
}

export function durableContent(
  messages: readonly Message[] | undefined,
  capture: boolean,
) {
  if (!capture) return "[content capture disabled]";
  const projected = messages?.map((message) => {
    if (message.role === "assistant" && message.stopReason === "error")
      return {
        role: message.role,
        parts: [{ type: "text", content: "[assistant error content omitted]" }],
      };
    const parts =
      typeof message.content === "string"
        ? [{ type: "text", content: message.content }]
        : message.content.map((block) => {
            switch (block.type) {
              case "text":
                return { type: "text", content: block.text };
              case "thinking":
                return { type: "reasoning", content: block.thinking };
              case "toolCall":
                return {
                  type: "tool_call",
                  id: block.id,
                  name: block.name,
                  arguments: block.arguments,
                };
            }
            return {
              type: "text",
              content: `[image omitted: ${block.mimeType}]`,
            };
          });
    return {
      role: message.role === "toolResult" ? "tool" : message.role,
      ...(message.role === "toolResult" ? { name: message.toolName } : {}),
      parts:
        message.role === "toolResult"
          ? [
              {
                type: "tool_call_response",
                id: message.toolCallId,
                response: parts,
              },
            ]
          : parts,
    };
  });
  return sanitizeTraceValue(projected, true);
}

export function durableUsage(
  usage: Extract<Message, { role: "assistant" | "toolResult" }>["usage"],
) {
  if (!usage) return {};
  const usageDetails: Record<string, number> = {};
  const costDetails: Record<string, number> = {};
  for (const [key, field] of [
    ["input", "input"],
    ["output", "output"],
    ["cacheRead", "cache_read_input_tokens"],
    ["cacheWrite", "cache_creation_input_tokens"],
    ["totalTokens", "total"],
  ] as const) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      usageDetails[field] = value;
  }
  for (const [key, field] of [
    ["input", "input"],
    ["output", "output"],
    ["cacheRead", "cache_read"],
    ["cacheWrite", "cache_write"],
    ["total", "total"],
  ] as const) {
    const value = usage.cost[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      costDetails[field] = value;
  }
  return { usageDetails, costDetails };
}
