import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  automationGenerationInputSchema,
  automationGenerationLimits,
} from "@home-agent/api/automations";
import { AppError } from "@home-agent/api/errors";
import { errorResponse, validateJson } from "@home-agent/api/errors/hono";
import type { createAutomationDraftGenerator } from "../automation-generation";
import type { createHouseholdReset } from "../household-reset";

export function createAutomationGenerationRoutes(
  generate: ReturnType<typeof createAutomationDraftGenerator>,
  timeoutMs: number,
  reset: ReturnType<typeof createHouseholdReset>,
) {
  let active = 0;
  return new Hono().post(
    "/generate",
    bodyLimit({
      maxSize: automationGenerationLimits.requestBytes,
      onError: (c) => errorResponse(c, new AppError("request_too_large")),
    }),
    validateJson(automationGenerationInputSchema),
    async (c) => {
      if (!generate) throw new AppError("model_not_configured");
      if (active >= automationGenerationLimits.concurrent)
        throw new AppError("thread_busy");
      const input = c.req.valid("json");
      const timeout = AbortSignal.timeout(
        Math.min(timeoutMs, automationGenerationLimits.timeoutMs - 1000),
      );
      const signal = AbortSignal.any([c.req.raw.signal, timeout]);
      const leave = reset.enter();
      active++;
      try {
        const result = await generate(input, signal);
        signal.throwIfAborted();
        if (
          Buffer.byteLength(JSON.stringify(result)) >
          automationGenerationLimits.responseBytes
        )
          throw new AppError("agent_execution_failed");
        return c.json(result);
      } catch (cause) {
        if (cause instanceof AppError) throw cause;
        throw new AppError(
          c.req.raw.signal.aborted
            ? "request_cancelled"
            : timeout.aborted
              ? "run_timeout"
              : "agent_execution_failed",
          { cause },
        );
      } finally {
        active--;
        leave();
      }
    },
  );
}
