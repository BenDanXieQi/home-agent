import { householdWorkflowInputSchema } from "./contracts";
import { Hono } from "hono";
import { requireLocalAccess } from "@home-agent/api/local-access";
import { handleHttpError, validateJson } from "@home-agent/api/errors/hono";
import { HouseholdError } from "../household/errors";
import { householdPublicError } from "../household/public-errors";
import type { createHouseholdWorkflows } from "./service";

export function createWorkflowRoutes({
  port,
  workflows,
}: {
  port: number;
  workflows: Pick<ReturnType<typeof createHouseholdWorkflows>, "run">;
}) {
  return new Hono()
    .use(requireLocalAccess([port, 5173], { webEntry: true }))
    .onError((error, c) =>
      handleHttpError(
        error instanceof HouseholdError ? householdPublicError(error) : error,
        c,
      ),
    )
    .post("/", validateJson(householdWorkflowInputSchema), async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(await workflows.run(c.req.valid("json"), c.req.raw.signal));
    });
}
