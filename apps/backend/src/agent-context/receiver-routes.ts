import { Hono } from "hono";
import { validator } from "hono/validator";
import type { z } from "zod";
import { requireLocalAccess } from "@home-agent/api/local-access";
import { AppError, validationIssues } from "@home-agent/api/errors";
import { readLimitedJson } from "@home-agent/api/http/read-body";
import {
  agentReceiptIndexSchema,
  agentReceiptDetailSchema,
  agentCurrentContextSchema,
  agentReceiptPolicy,
  agentReceiptQuerySchema,
} from "@home-agent/api/agent-receipts";

/** Reads the Agent process. Never substitutes a Backend publication for a receipt. */
export function createAgentReceiverRoutes({
  port,
  timeoutMs,
  readAgentUrl,
}: {
  port: number;
  timeoutMs: number;
  readAgentUrl: () => Promise<string>;
}) {
  async function read<S extends z.ZodType>(
    path: string,
    schema: S,
    signal: AbortSignal,
  ) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const response = await fetch(new URL(path, await readAgentUrl()), {
        redirect: "error",
        signal: combined,
        headers: { Accept: "application/json" },
      });
      if (response.status === 404) throw new AppError("not_found");
      if (!response.ok) throw new AppError("agent_unavailable");
      return schema.parse(
        await readLimitedJson(
          response,
          agentReceiptPolicy.responseBytes,
          combined,
        ),
      );
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError(
        signal.aborted
          ? "request_cancelled"
          : timeout.aborted
            ? "agent_timeout"
            : "agent_unavailable",
        { cause },
      );
    }
  }
  return new Hono()
    .use(requireLocalAccess([port, 5173], { webEntry: true }))
    .use(async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .get(
      "/",
      validator("query", (value) => {
        const parsed = agentReceiptQuerySchema.safeParse(value);
        if (!parsed.success)
          throw new AppError("invalid_request", {
            issues: validationIssues(parsed.error),
          });
        return parsed.data;
      }),
      async (c) => {
        const query = c.req.valid("query");
        const params = new URLSearchParams();
        if (
          query.journal_id !== undefined &&
          query.after_sequence !== undefined
        ) {
          params.set("journal_id", query.journal_id);
          params.set("after_sequence", String(query.after_sequence));
        }
        return c.json(
          await read(
            `/api/context-receipts?${params.toString()}`,
            agentReceiptIndexSchema,
            c.req.raw.signal,
          ),
        );
      },
    )
    .get("/current", async (c) =>
      c.json(
        await read(
          "/api/context-receipts/current",
          agentCurrentContextSchema,
          c.req.raw.signal,
        ),
      ),
    )
    .get("/:id", async (c) => {
      const id = agentReceiptDetailSchema.shape.receipt.shape.id.safeParse(
        c.req.param("id"),
      );
      if (!id.success) throw new AppError("invalid_request");
      return c.json(
        await read(
          `/api/context-receipts/${id.data}`,
          agentReceiptDetailSchema,
          c.req.raw.signal,
        ),
      );
    });
}
