import { createRouteApp, type RouteContext } from "../definition";
import { validator } from "hono/validator";
import { AppError, validationIssues } from "@home-agent/api/errors";
import { agentReceiptQuerySchema } from "@home-agent/api/agent-receipts";

export function createRoutes({
  context: receiver,
}: Pick<RouteContext, "context">) {
  return createRouteApp()
    .get("/received-context", (c) => c.json(receiver.snapshot()))

    .get(
      "/context-receipts",
      validator("query", (value) => {
        const parsed = agentReceiptQuerySchema.safeParse(value);
        if (!parsed.success)
          throw new AppError("invalid_request", {
            issues: validationIssues(parsed.error),
          });

        return parsed.data;
      }),
      (c) => c.json(receiver.receiptIndex(c.req.valid("query"))),
    )

    .get("/context-receipts/current", (c) =>
      c.json({
        journal_id: receiver.journalId(),
        context: receiver.snapshot(),
      }),
    )

    .get("/context-receipts/:id", (c) => {
      const result = receiver.receipt(c.req.param("id"));
      if (!result) throw new AppError("not_found");

      return c.json(result);
    });
}
