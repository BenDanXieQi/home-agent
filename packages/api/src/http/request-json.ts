import type { z } from "zod";
import { apiErrorSchema, type ErrorCode } from "../contracts/errors";
import { AppError } from "../errors";
import { readLimitedJson } from "./read-body";

/** One bounded service request. The caller owns endpoint policy; never retries. */
export async function requestJson<T>(
  send: (signal: AbortSignal) => Promise<Pick<Response, "body" | "ok">>,
  schema: z.ZodType<T>,
  options: {
    signal: AbortSignal;
    timeoutMs: number;
    maxBytes: number;
    unavailableCode: ErrorCode;
  },
) {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = AbortSignal.any([options.signal, timeout]);
  try {
    signal.throwIfAborted();
    const response = await send(signal);
    const body = await readLimitedJson(response, options.maxBytes, signal);
    if (!response.ok) {
      const error = apiErrorSchema.safeParse(body);
      if (error.success)
        throw new AppError(error.data.code, {
          params: error.data.params,
          issues: error.data.issues,
        });
      throw new AppError(options.unavailableCode);
    }
    const result = schema.parse(body);
    signal.throwIfAborted();
    return result;
  } catch (cause) {
    if (options.signal.aborted)
      throw new AppError("request_cancelled", { cause });
    if (timeout.aborted) throw new AppError("agent_timeout", { cause });
    if (cause instanceof AppError) throw cause;
    throw new AppError(options.unavailableCode, { cause });
  }
}
