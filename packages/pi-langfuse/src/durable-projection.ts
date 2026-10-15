import type { EntryRecord } from "@earendil-works/pi-durable";
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

export function durableDiagnosticCount(entry: EntryRecord | undefined) {
  const data = entry?.data;
  return data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    "diagnostics" in data &&
    Array.isArray(data.diagnostics)
    ? data.diagnostics.length
    : 0;
}

/** Project committed messages without provider configuration, deltas or raw diagnostics. */
export function durableContent(
  messages: readonly Message[] | undefined,
  capture: boolean,
  diagnosticCount = 0,
) {
  if (!capture) return "[content capture disabled]";
  const projected = messages?.map((message) => {
    if (message.role === "assistant" && message.stopReason === "error")
      return {
        role: message.role,
        parts: [{ type: "text", content: "[assistant error content omitted]" }],
      };
    // The public ToolResultEntry shape appends rendered diagnostics as its last text block.
    // That block can contain raw errors, headers or credentials even when the tool succeeds.
    const omitDiagnosticBlock =
      message.role === "toolResult" &&
      diagnosticCount > 0 &&
      message.content.at(-1)?.type === "text";
    const blockCount = message.content.length - (omitDiagnosticBlock ? 1 : 0);
    const parts =
      message.role === "toolResult" && message.isError
        ? [{ type: "text", content: "[tool error content omitted]" }]
        : typeof message.content === "string"
          ? [{ type: "text", content: message.content }]
          : message.content.slice(0, blockCount).map((block) => {
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
      ...(omitDiagnosticBlock ? { diagnosticsOmitted: diagnosticCount } : {}),
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
