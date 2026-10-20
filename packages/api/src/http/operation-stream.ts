import type { z } from "zod";
import { apiErrorSchema } from "../contracts/errors";
import { AppError } from "../errors";
import { consumeEventStream } from "./event-stream";

/** Consume one operation; a result frame ends consumption without waiting for EOF. */
export async function consumeOperationStream<Progress, Result>(
  contract: { progress: z.ZodType<Progress>; result: z.ZodType<Result> },
  request: Parameters<typeof consumeEventStream>[0]["request"],
  signal: AbortSignal,
  receive?: (progress: Progress) => void | Promise<void>,
) {
  let result: { value: Result } | undefined;
  await consumeEventStream(
    {
      request: async (requestSignal) => {
        const response = await request(requestSignal);
        if (!response.ok) {
          const payload: unknown = await new Response(response.body).json();
          const error = apiErrorSchema.parse(payload);
          throw new AppError(error.code, {
            params: error.params,
            issues: error.issues,
          });
        }
        return response;
      },
      signal,
      maxBufferSize: 16 * 1024 * 1024,
      firstEventTimeoutMs: 30_000,
      silenceMs: 45_000,
    },
    async (message) => {
      const payload: unknown = JSON.parse(message.data);
      switch (message.event) {
        case "progress": {
          const progress = contract.progress.parse(payload);
          await receive?.(progress);
          break;
        }
        case "result":
          result = { value: contract.result.parse(payload) };
          return false;
        case "error": {
          const error = apiErrorSchema.parse(payload);
          throw new AppError(error.code, {
            params: error.params,
            issues: error.issues,
          });
        }
        case "heartbeat":
          break;
        default:
          throw new SyntaxError("Unexpected operation stream event");
      }
      return undefined;
    },
  );
  if (!result) throw new AppError("agent_execution_failed");
  return result.value;
}
