import type { z } from "zod";
import { chatInputSchema, chatResponseSchema } from "@home-agent/api/contracts";
import {
  agentWorkflowInputSchema,
  agentWorkflowResultSchema,
  agentWorkflowLimits,
} from "@home-agent/api/agent-workflows";
import {
  agentReceiptIndexSchema,
  agentReceiptDetailSchema,
  agentCurrentContextSchema,
  agentReceiptPolicy,
  agentReceiptQuerySchema,
} from "@home-agent/api/agent-receipts";
import { requestJson } from "@home-agent/api/http/request-json";
import { tracedFetch } from "@home-agent/observability";
import { AppError } from "@home-agent/api/errors";

/** The address is resolved for every request so saved connection changes apply. */
export function createAgentClient(options: {
  readAgentUrl: () => Promise<string>;
  timeoutMs: number;
}) {
  function request<T>(
    path: string,
    schema: z.ZodType<T>,
    maxBytes: number,
    signal: AbortSignal,
    init: Pick<RequestInit, "method" | "body" | "headers"> = {},
  ) {
    return requestJson(
      async (requestSignal) => {
        const url = new URL(path, await options.readAgentUrl());
        requestSignal.throwIfAborted();
        return tracedFetch(url, {
          ...init,
          redirect: "error",
          signal: requestSignal,
        });
      },
      schema,
      {
        signal,
        timeoutMs: options.timeoutMs,
        maxBytes,
        unavailableCode: "agent_unavailable",
      },
    );
  }

  return {
    chat(input: z.output<typeof chatInputSchema>, signal: AbortSignal) {
      return request("/api/chat", chatResponseSchema, 512 * 1024, signal, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
    },
    workflow(
      input: z.output<typeof agentWorkflowInputSchema>,
      signal: AbortSignal,
    ) {
      const body = JSON.stringify(input);
      if (Buffer.byteLength(body) > agentWorkflowLimits.requestBytes)
        throw new AppError("request_too_large");
      return request(
        "/api/workflows",
        agentWorkflowResultSchema,
        agentWorkflowLimits.responseBytes,
        signal,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        },
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
        agentReceiptPolicy.responseBytes,
        signal,
      );
    },
    currentContext(signal: AbortSignal) {
      return request(
        "/api/context-receipts/current",
        agentCurrentContextSchema,
        agentReceiptPolicy.responseBytes,
        signal,
      );
    },
    receipt(id: string, signal: AbortSignal) {
      return request(
        `/api/context-receipts/${encodeURIComponent(id)}`,
        agentReceiptDetailSchema,
        agentReceiptPolicy.responseBytes,
        signal,
      );
    },
  };
}
