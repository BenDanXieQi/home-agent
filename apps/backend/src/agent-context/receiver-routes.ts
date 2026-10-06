import { Hono } from "hono";
import { validator } from "hono/validator";
import { requireLocalAccess } from "@home-agent/api/local-access";
import { AppError, validationIssues } from "@home-agent/api/errors";
import type { createAgentClient } from "../agent-client";
import {
  agentReceiptDetailSchema,
  agentReceiptQuerySchema,
} from "@home-agent/api/agent-receipts";

/** Reads the Agent process. Never substitutes a Backend publication for a receipt. */
export function createAgentReceiverRoutes({
  port,
  agent,
}: {
  port: number;
  agent: Pick<
    ReturnType<typeof createAgentClient>,
    "receipts" | "currentContext" | "receipt"
  >;
}) {
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
        return c.json(
          await agent.receipts(c.req.valid("query"), c.req.raw.signal),
        );
      },
    )
    .get("/current", async (c) =>
      c.json(await agent.currentContext(c.req.raw.signal)),
    )
    .get("/:id", async (c) => {
      const id = agentReceiptDetailSchema.shape.receipt.shape.id.safeParse(
        c.req.param("id"),
      );
      if (!id.success) throw new AppError("invalid_request");
      return c.json(await agent.receipt(id.data, c.req.raw.signal));
    });
}
