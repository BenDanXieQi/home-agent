import {
  speechDialogueLimits,
  speechDialogueResponseSchema,
  type speechDialogueRequestSchema,
} from "@home-agent/api/speech-dialogue";
import { apiErrorSchema } from "@home-agent/api/contracts";
import { AppError } from "@home-agent/api/errors";
import { readLimitedJson } from "@home-agent/api/http/read-body";
import { tracedFetch } from "@home-agent/observability";
import type { z } from "zod";

export function createSpeechDialogueClient(
  readAgentUrl: () => Promise<string>,
) {
  return async (
    input: z.infer<typeof speechDialogueRequestSchema>,
    signal: AbortSignal,
  ) => {
    let httpStatus: number | undefined;
    try {
      const url = await readAgentUrl();
      signal.throwIfAborted();
      const response = await tracedFetch(new URL("/api/speech-dialogue", url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal,
      });
      httpStatus = response.status;
      const body = await readLimitedJson(
        response,
        speechDialogueLimits.responseBytes,
        signal,
      );
      if (!response.ok) {
        const error = apiErrorSchema.safeParse(body);
        const traceId = error.success ? error.data.traceId : undefined;
        // Preserve only known diagnostics; remote messages and parameters can contain speech.
        throw new AppError(error.success ? error.data.code : "http_error", {
          params: {
            httpStatus,
            ...(traceId && /^[0-9a-f]{32}$/.test(traceId) ? { traceId } : {}),
          },
        });
      }
      return speechDialogueResponseSchema.parse(body);
    } catch (cause) {
      if (
        signal.aborted ||
        (httpStatus !== undefined && cause instanceof AppError)
      )
        throw cause;
      throw new AppError(
        httpStatus === undefined
          ? "agent_unavailable"
          : httpStatus >= 400
            ? "http_error"
            : "agent_execution_failed",
        {
          ...(httpStatus === undefined ? {} : { params: { httpStatus } }),
          cause,
        },
      );
    }
  };
}
