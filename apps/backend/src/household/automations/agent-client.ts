import {
  automationDraftSchema,
  automationGenerationInputSchema,
  automationGenerationLimits,
  validateAutomationCapabilities,
} from "@home-agent/api/automations";
import { apiErrorSchema } from "@home-agent/api/contracts";
import { AppError } from "@home-agent/api/errors";
import { readLimitedJson } from "@home-agent/api/http/read-body";
import { tracedFetch } from "@home-agent/observability";
import type { z } from "zod";

export function createAutomationGenerationClient(
  readAgentUrl: () => Promise<string>,
) {
  return async (
    input: z.infer<typeof automationGenerationInputSchema>,
    signal?: AbortSignal,
  ) => {
    const timeout = AbortSignal.timeout(automationGenerationLimits.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const request = automationGenerationInputSchema.safeParse(input);
      if (!request.success) throw new AppError("invalid_request");
      const body = JSON.stringify(request.data);
      if (Buffer.byteLength(body) > automationGenerationLimits.requestBytes)
        throw new AppError("request_too_large");
      const url = await readAgentUrl();
      requestSignal.throwIfAborted();
      const response = await tracedFetch(
        new URL("/api/automations/generate", url),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body,
          redirect: "error",
          signal: requestSignal,
        },
      );
      const result = await readLimitedJson(
        response,
        automationGenerationLimits.responseBytes,
        requestSignal,
      );
      if (!response.ok) {
        const error = apiErrorSchema.safeParse(result);
        if (error.success) {
          switch (error.data.code) {
            case "model_not_configured":
            case "thread_busy":
            case "request_too_large":
            case "run_timeout":
            case "request_cancelled":
            case "database_not_configured":
            case "persistence_unavailable":
              throw new AppError(error.data.code);
          }
        }
        throw new AppError("agent_execution_failed");
      }
      const parsed = automationDraftSchema.safeParse(result);
      if (!parsed.success) throw new AppError("agent_execution_failed");
      if (
        parsed.data.definition &&
        validateAutomationCapabilities(
          parsed.data.definition,
          input.capabilities,
        ).length
      )
        throw new AppError("agent_execution_failed");
      return parsed.data;
    } catch (cause) {
      if (requestSignal.aborted) {
        const timedOut =
          timeout.aborted ||
          (requestSignal.reason instanceof Error &&
            requestSignal.reason.name === "TimeoutError");
        throw new AppError(timedOut ? "agent_timeout" : "request_cancelled", {
          cause,
        });
      }
      if (cause instanceof AppError) throw cause;
      // Provider and transport details can contain credentials.
      throw new AppError("agent_unavailable", { cause });
    }
  };
}
