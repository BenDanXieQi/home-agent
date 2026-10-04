import type { createHouseholdReset } from "../household-reset";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AppError } from "@home-agent/api/errors";
import { errorResponse, validateJson } from "@home-agent/api/errors/hono";
import {
  analysisRequestSchema,
  roomAnalysisLimits,
} from "@home-agent/api/room-analysis";
import type { createRoomAnalysisInterpreter } from "../room-analysis";

export function createRoomAnalysisRoutes(
  interpret: ReturnType<typeof createRoomAnalysisInterpreter>,
  timeoutMs: number,
  reset: ReturnType<typeof createHouseholdReset>,
) {
  let active = 0;
  return new Hono().post(
    "/",
    bodyLimit({
      maxSize: roomAnalysisLimits.contextBytes + 1024,
      onError: (c) => errorResponse(c, new AppError("request_too_large")),
    }),
    validateJson(analysisRequestSchema),
    async (c) => {
      if (!interpret) throw new AppError("model_not_configured");
      if (active >= roomAnalysisLimits.concurrent)
        throw new AppError("thread_busy");
      const input = c.req.valid("json");
      if (!input.context.facts.length) throw new AppError("invalid_request");
      const timeout = AbortSignal.timeout(
        Math.min(timeoutMs, roomAnalysisLimits.timeoutMs - 1000),
      );
      const signal = AbortSignal.any([c.req.raw.signal, timeout]);
      const leave = reset.enter();
      active++;
      try {
        const result = await interpret(input, signal);
        signal.throwIfAborted();
        if (
          Buffer.byteLength(JSON.stringify(result)) >
          roomAnalysisLimits.responseBytes
        )
          throw new AppError("agent_execution_failed");
        return c.json(result);
      } catch (cause) {
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
