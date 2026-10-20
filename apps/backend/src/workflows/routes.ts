import { streamOperation } from "@home-agent/api/http/stream-operation";
import { AppError } from "@home-agent/api/errors";
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
    .post("/", validateJson(householdWorkflowInputSchema), (c) => {
      const input = c.req.valid("json");
      return streamOperation(
        c,
        (signal, receive) => workflows.run(input, signal, receive),
        (error) =>
          error instanceof HouseholdError
            ? householdPublicError(error)
            : error instanceof AppError
              ? error
              : new AppError("internal_error", { cause: error }),
      );
    });
}
