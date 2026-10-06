import { AppError } from "@home-agent/api/errors";
import { apiErrorSchema } from "@home-agent/api/contracts";
import {
  automationDecisionReceiptSchema,
  automationDecisionLimits,
} from "@home-agent/api/automations";
import { readLimitedJson } from "@home-agent/api/http/read-body";
import { tracedFetch } from "@home-agent/observability";

export function createAutomationDecisionClient(
  readAgentUrl: () => Promise<string>,
) {
  return async (body: unknown, signal: AbortSignal) => {
    const response = await tracedFetch(
      new URL("/api/automations/decision", await readAgentUrl()),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      },
    );
    const receipt = await readLimitedJson(
      response,
      automationDecisionLimits.responseBytes,
      signal,
    );
    if (!response.ok) {
      const error = apiErrorSchema.safeParse(receipt);
      if (
        error.success &&
        [
          "thread_busy",
          "model_not_configured",
          "request_too_large",
          "database_not_configured",
          "invalid_request",
        ].includes(error.data.code)
      )
        throw new AppError(error.data.code);
      throw new Error("Automation decision service unavailable");
    }
    return automationDecisionReceiptSchema.parse(receipt);
  };
}
