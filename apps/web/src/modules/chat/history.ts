import {
  chatHistoryListInputSchema,
  chatHistoryListSchema,
  chatHistoryInputSchema,
  chatHistorySchema,
} from "@home-agent/api/contracts";
import type { z } from "zod";
import { requestJson } from "../../api/client";

export function listChatHistory(
  input: z.input<typeof chatHistoryListInputSchema>,
  signal: AbortSignal,
) {
  return requestJson(
    (client, options) =>
      client.api.chat.history.list.$post({ json: input }, options),
    chatHistoryListSchema,
    { signal, timeoutMs: 50_000 },
  );
}
export function readChatHistory(
  input: z.input<typeof chatHistoryInputSchema>,
  signal: AbortSignal,
) {
  return requestJson(
    (client, options) =>
      client.api.chat.history.read.$post({ json: input }, options),
    chatHistorySchema,
    { signal, timeoutMs: 50_000 },
  );
}
