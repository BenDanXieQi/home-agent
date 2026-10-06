import {
  chatInputSchema,
  chatResponseSchema,
  apiErrorSchema,
} from "@home-agent/api/contracts";
import { AppError } from "@home-agent/api/errors";
import { errorResponse, validateJson } from "@home-agent/api/errors/hono";
import { readLimitedJson } from "@home-agent/api/http/read-body";
import { tracedFetch } from "@home-agent/observability";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireLocalAccess } from "@home-agent/api/local-access";

export function createChatRoutes({
  port,
  timeoutMs,
  readAgentUrl,
}: {
  port: number;
  timeoutMs: number;
  readAgentUrl: () => Promise<string>;
}) {
  return new Hono()
    .use(requireLocalAccess([port, 5173], { webEntry: true }))
    .post(
      "/",
      bodyLimit({
        maxSize: 32768,
        onError: (c) => errorResponse(c, new AppError("request_too_large")),
      }),
      validateJson(chatInputSchema),
      async (c) => {
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = AbortSignal.any([c.req.raw.signal, timeout]);
        try {
          const url = await readAgentUrl();
          const response = await tracedFetch(new URL("/api/chat", url), {
            method: "POST",
            redirect: "error",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(c.req.valid("json")),
            signal,
          });
          const body = await readLimitedJson(response, 512 * 1024, signal);
          if (!response.ok) {
            const error = apiErrorSchema.safeParse(body);
            throw new AppError(
              error.success ? error.data.code : "agent_unavailable",
            );
          }
          return c.json(chatResponseSchema.parse(body));
        } catch (cause) {
          if (cause instanceof AppError) throw cause;
          throw new AppError(
            c.req.raw.signal.aborted
              ? "request_cancelled"
              : timeout.aborted
                ? "agent_timeout"
                : "agent_unavailable",
            { cause },
          );
        }
      },
    );
}
