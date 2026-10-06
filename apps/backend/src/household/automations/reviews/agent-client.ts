import { tracedFetch } from "@home-agent/observability";
import { readLimitedJson } from "@home-agent/api/http/read-body";
import { apiErrorSchema } from "@home-agent/api/contracts";
import {
  automationReviewResponseSchema,
  type automationReviewRequestSchema,
} from "@home-agent/api/automation-reviews";

export class AutomationReviewNotAcceptedError extends Error {
  constructor(
    readonly reason:
      | "thread_busy"
      | "model_not_configured"
      | "request_too_large",
  ) {
    super(reason);
    this.name = "AutomationReviewNotAcceptedError";
  }
}

export function createAutomationReviewClient(
  readAgentUrl: () => Promise<string>,
) {
  async function post(path: string, input: unknown, signal: AbortSignal) {
    const response = await tracedFetch(new URL(path, await readAgentUrl()), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
      redirect: "error",
    });
    const body = await readLimitedJson(response, 64 * 1024, signal);
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(body);
      if (
        parsed.success &&
        (parsed.data.code === "thread_busy" ||
          parsed.data.code === "model_not_configured" ||
          parsed.data.code === "request_too_large")
      )
        throw new AutomationReviewNotAcceptedError(parsed.data.code);
      throw new Error("Agent 情景复核服务暂不可用");
    }
    return automationReviewResponseSchema.parse(body);
  }
  return {
    submit(
      request: ReturnType<typeof automationReviewRequestSchema.parse>,
      signal: AbortSignal,
    ) {
      return post("/api/automations/review", request, signal);
    },
  };
}
