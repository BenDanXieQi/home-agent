import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { AppError } from "@home-agent/api/errors";
import { validateJson, errorResponse } from "@home-agent/api/errors/hono";
import { tracedFetch } from "@home-agent/observability";
import { readLimitedJson } from "@home-agent/api/http/read-body";
import {
  apiErrorSchema,
  chatHistoryListInputSchema,
  chatHistoryListSchema,
  chatHistoryInputSchema,
  chatHistorySchema,
  chatHistoryResponseBytes,
} from "@home-agent/api/contracts";
import type { ChatDependencies } from "./routes";

export function createChatHistoryProxy({
  readAgentUrl,
  readHouseholdScope,
}: Pick<ChatDependencies, "readAgentUrl" | "readHouseholdScope">) {
  async function query<S extends z.ZodType>(
    path: "list" | "read",
    input: object,
    schema: S,
    requestSignal: AbortSignal,
  ) {
    const scope = readHouseholdScope();
    const timeout = AbortSignal.timeout(45_000);
    const signal = AbortSignal.any([requestSignal, timeout]);
    try {
      const response = await tracedFetch(
        new URL(`/api/chat/history/${path}`, await readAgentUrl()),
        {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal,
        },
      );
      const body = await readLimitedJson(
        response,
        chatHistoryResponseBytes,
        signal,
      );
      if (readHouseholdScope() !== scope)
        throw new AppError("request_cancelled");
      if (!response.ok) {
        const parsed = apiErrorSchema.safeParse(body);
        throw parsed.success
          ? new AppError(parsed.data.code)
          : new AppError("agent_unavailable");
      }
      return schema.parse(body);
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError(
        requestSignal.aborted
          ? "request_cancelled"
          : timeout.aborted
            ? "agent_timeout"
            : "agent_unavailable",
        { cause },
      );
    }
  }
  return new Hono()
    .use(
      bodyLimit({
        maxSize: 4096,
        onError: (c) => errorResponse(c, new AppError("request_too_large")),
      }),
    )
    .post("/list", validateJson(chatHistoryListInputSchema), async (c) =>
      c.json(
        await query(
          "list",
          c.req.valid("json"),
          chatHistoryListSchema,
          c.req.raw.signal,
        ),
      ),
    )
    .post("/read", validateJson(chatHistoryInputSchema), async (c) =>
      c.json(
        await query(
          "read",
          c.req.valid("json"),
          chatHistorySchema,
          c.req.raw.signal,
        ),
      ),
    );
}
