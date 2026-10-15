import type { z } from "zod";
import {
  chatInputSchema,
  chatResponseSchema,
} from "@home-agent/agent/assistant/contracts";
import {
  agentWorkflowInputSchema,
  agentWorkflowResultSchema,
} from "@home-agent/agent/workflows";
import {
  agentReceiptIndexSchema,
  agentReceiptDetailSchema,
  agentCurrentContextSchema,
  agentReceiptQuerySchema,
} from "@home-agent/agent/context/contracts";
import { requestJson } from "@home-agent/api/http/request-json";
import { tracedFetch, withAgentTrace } from "@home-agent/observability";

export function createAgentClient(options: {
  readAgentUrl: () => Promise<string>;
  timeoutMs: number;
}) {
  function request<T>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    init: Pick<RequestInit, "method" | "body" | "headers"> = {},
  ) {
    return requestJson(
      async (requestSignal) => {
        const url = new URL(path, await options.readAgentUrl());
        requestSignal.throwIfAborted();
        return tracedFetch({ from: "backend", to: "agent" }, url, {
          ...init,
          redirect: "error",
          signal: requestSignal,
        });
      },
      schema,
      {
        signal,
        timeoutMs: options.timeoutMs,
        unavailableCode: "agent_unavailable",
      },
    );
  }

  return {
    chat(input: z.output<typeof chatInputSchema>, signal: AbortSignal) {
      return withAgentTrace(() =>
        request("/api/chat", chatResponseSchema, signal, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }),
      );
    },
    workflow(
      input: z.output<typeof agentWorkflowInputSchema>,
      signal: AbortSignal,
    ) {
      const body = JSON.stringify(input);
      return withAgentTrace(() =>
        request("/api/workflows", agentWorkflowResultSchema, signal, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
      );
    },
    receipts(
      query: z.output<typeof agentReceiptQuerySchema>,
      signal: AbortSignal,
    ) {
      const params = new URLSearchParams();
      if (
        query.journal_id !== undefined &&
        query.after_sequence !== undefined
      ) {
        params.set("journal_id", query.journal_id);
        params.set("after_sequence", String(query.after_sequence));
      }
      return request(
        `/api/context-receipts?${params.toString()}`,
        agentReceiptIndexSchema,
        signal,
      );
    },
    currentContext(signal: AbortSignal) {
      return request(
        "/api/context-receipts/current",
        agentCurrentContextSchema,
        signal,
      );
    },
    receipt(id: string, signal: AbortSignal) {
      return request(
        `/api/context-receipts/${encodeURIComponent(id)}`,
        agentReceiptDetailSchema,
        signal,
      );
    },
  };
}
