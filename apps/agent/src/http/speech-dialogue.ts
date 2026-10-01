import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AppError } from "@home-agent/api/errors";
import { errorResponse, validateJson } from "@home-agent/api/errors/hono";
import {
  speechDialogueRequestSchema,
  speechDialogueLimits,
  validSpeechDialogueRequest,
} from "@home-agent/api/speech-dialogue";
import type { createSpeechDialogueAgent } from "../graph/speech-dialogue";
import { createHouseholdReset } from "../household-reset";

export function createSpeechDialogueRoutes(
  agent: ReturnType<typeof createSpeechDialogueAgent>,
  reset = createHouseholdReset(),
) {
  let active = false;
  return new Hono().post(
    "/",
    bodyLimit({
      maxSize: speechDialogueLimits.requestBytes,
      onError: (c) => errorResponse(c, new AppError("request_too_large")),
    }),
    validateJson(speechDialogueRequestSchema),
    async (c) => {
      if (!agent) throw new AppError("model_not_configured");
      if (active) throw new AppError("thread_busy");
      const input = c.req.valid("json");
      const now = Date.now();
      if (!validSpeechDialogueRequest(input, now))
        throw new AppError("invalid_request");
      const timeout = AbortSignal.timeout(
        Math.max(
          1,
          Math.min(
            speechDialogueLimits.timeoutMs - 1000,
            input.expiresAt - now,
          ),
        ),
      );
      const signal = AbortSignal.any([timeout, c.req.raw.signal]);
      const leave = reset.enter();
      active = true;
      try {
        const result = await agent.graph.invoke({ input }, { signal });
        signal.throwIfAborted();
        if (
          !result.output ||
          Buffer.byteLength(JSON.stringify(result.output)) >
            speechDialogueLimits.responseBytes
        )
          throw new AppError("agent_execution_failed");
        return c.json(result.output);
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
        active = false;
        leave();
      }
    },
  );
}
