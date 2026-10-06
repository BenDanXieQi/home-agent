import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AppError } from "@home-agent/api/errors";
import { errorResponse, validateJson } from "@home-agent/api/errors/hono";
import {
  automationDecisionInputSchema,
  automationDecisionLimits,
} from "@home-agent/api/automations";
import { automationReviewRequestSchema } from "@home-agent/api/automation-reviews";
import type { createAutomationReasoning } from "../automation-reasoning";
import type { createHouseholdReset } from "../household-reset";

export function createAutomationReasoningRoutes(
  reasoning: ReturnType<typeof createAutomationReasoning>,
  timeoutMs: number,
  reset: ReturnType<typeof createHouseholdReset>,
) {
  const app = new Hono();
  app.use(
    bodyLimit({
      maxSize: automationDecisionLimits.requestBytes,
      onError: (c) => errorResponse(c, new AppError("request_too_large")),
    }),
  );
  app.use(async (c, next) => {
    if (!reasoning) throw new AppError("database_not_configured");
    const leave = reset.enter();
    c.header("Cache-Control", "no-store");
    try {
      await next();
    } finally {
      leave();
    }
  });
  const deadline = (requestSignal: AbortSignal, expiresAt: string) =>
    AbortSignal.any([
      requestSignal,
      AbortSignal.timeout(
        Math.max(
          1,
          Math.min(
            timeoutMs,
            automationDecisionLimits.timeoutMs - 1000,
            Date.parse(expiresAt) - Date.now(),
          ),
        ),
      ),
    ]);
  app.post(
    "/review",
    validateJson(automationReviewRequestSchema),
    async (c) => {
      if (!reasoning) throw new AppError("database_not_configured");
      const input = c.req.valid("json");
      const signal = deadline(c.req.raw.signal, input.expires_at);
      try {
        return c.json(await reasoning.review(input, signal));
      } catch (cause) {
        if (signal.aborted)
          throw new AppError(
            c.req.raw.signal.aborted ? "request_cancelled" : "run_timeout",
            { cause },
          );
        if (cause instanceof AppError) throw cause;
        throw new AppError("agent_execution_failed", { cause });
      }
    },
  );
  app.post(
    "/decision",
    validateJson(automationDecisionInputSchema),
    async (c) => {
      if (!reasoning) throw new AppError("database_not_configured");
      const input = c.req.valid("json");
      const signal = deadline(c.req.raw.signal, input.expires_at);
      try {
        return c.json(await reasoning.decision(input, signal));
      } catch (cause) {
        if (signal.aborted)
          throw new AppError(
            c.req.raw.signal.aborted ? "request_cancelled" : "run_timeout",
            { cause },
          );
        if (cause instanceof AppError) throw cause;
        throw new AppError("agent_execution_failed", { cause });
      }
    },
  );
  return app;
}
