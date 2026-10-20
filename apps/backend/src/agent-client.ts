import { consumeOperationStream } from "@home-agent/api/http/operation-stream";
import { AppError } from "@home-agent/api/errors";
import type { z } from "zod";
import {
  chatInputSchema,
  chatStreamContract,
} from "@home-agent/agent/assistant/contracts";
import {
  agentWorkflowInputSchema,
  agentWorkflowStreamContract,
} from "@home-agent/agent/workflows";
import {
  agentReceiptIndexSchema,
  agentReceiptDetailSchema,
  agentCurrentContextSchema,
  agentReceiptQuerySchema,
} from "@home-agent/agent/context/contracts";
import { requestJson } from "@home-agent/api/http/request-json";
import {
  bindTraceSession,
  tracedFetch,
  withAgentTrace,
} from "@home-agent/observability";

export const AGENT_OPERATION_TIMEOUT_MS = 20 * 60_000;

export function createAgentClient(options: {
  readAgentUrl: () => Promise<string>;
  timeoutMs: number;
}) {
  function request<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal) {
    return requestJson(
      async (requestSignal) => {
        const url = new URL(path, await options.readAgentUrl());
        requestSignal.throwIfAborted();
        return tracedFetch({ from: "backend", to: "agent" }, url, {
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

  function operation<Progress, Result>(
    path: string,
    contract: { progress: z.ZodType<Progress>; result: z.ZodType<Result> },
    input: unknown,
    requestSignal: AbortSignal,
    receive?: (progress: Progress, signal: AbortSignal) => void | Promise<void>,
  ) {
    return withAgentTrace(async () => {
      const timeout = AbortSignal.timeout(AGENT_OPERATION_TIMEOUT_MS);
      const signal = AbortSignal.any([requestSignal, timeout]);
      try {
        signal.throwIfAborted();
        return await consumeOperationStream(
          contract,
          async (streamSignal) => {
            const url = new URL(path, await options.readAgentUrl());
            streamSignal.throwIfAborted();
            return tracedFetch({ from: "backend", to: "agent" }, url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(input),
              signal: streamSignal,
              redirect: "error",
            });
          },
          signal,
          async (progress) => {
            await receive?.(progress, signal);
          },
        );
      } catch (cause) {
        if (requestSignal.aborted)
          throw new AppError("request_cancelled", { cause });
        if (timeout.aborted) throw new AppError("agent_timeout", { cause });
        if (cause instanceof AppError) throw cause;
        throw new AppError("agent_unavailable", { cause });
      }
    });
  }

  return {
    chat(
      input: z.output<typeof chatInputSchema>,
      signal: AbortSignal,
      receive?: (
        progress: z.output<typeof chatStreamContract.progress>,
        signal: AbortSignal,
      ) => void | Promise<void>,
    ) {
      return operation(
        "/api/chat",
        chatStreamContract,
        input,
        signal,
        async (progress, operationSignal) => {
          bindTraceSession(progress.session_id);
          await receive?.(progress, operationSignal);
        },
      );
    },
    workflow(
      input: z.output<typeof agentWorkflowInputSchema>,
      signal: AbortSignal,
      receive?: (
        progress: z.output<typeof agentWorkflowStreamContract.progress>,
        signal: AbortSignal,
      ) => void | Promise<void>,
    ) {
      return operation(
        "/api/workflows",
        agentWorkflowStreamContract,
        input,
        signal,
        async (progress, operationSignal) => {
          bindTraceSession(progress.progress.session_id);
          await receive?.(progress, operationSignal);
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
