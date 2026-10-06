import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AppError } from "@home-agent/api/errors";
import {
  errorResponse,
  handleHttpError,
  validateJson,
} from "@home-agent/api/errors/hono";
import { requireLocalAccess } from "@home-agent/api/local-access";
import { automationReviewRunsQuerySchema } from "@home-agent/api/automation-reviews";
import { HouseholdError } from "../../errors";
import { safeMijiaError } from "../../../mijia/errors";
import type { createAutomationReviewService } from "./service";

export function createAutomationReviewRoutes(
  port: number,
  service: ReturnType<typeof createAutomationReviewService> | undefined,
) {
  const app = new Hono();
  app.use(requireLocalAccess([port, 5173], { webEntry: true }));
  app.use(
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => errorResponse(c, new AppError("request_too_large")),
    }),
  );
  app.use(async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.onError((error, c) =>
    handleHttpError(
      error instanceof HouseholdError ? safeMijiaError(error) : error,
      c,
    ),
  );
  const current = () => {
    if (!service) throw new AppError("persistence_unavailable");
    return service;
  };
  return app.post(
    "/runs",
    validateJson(automationReviewRunsQuerySchema),
    async (c) => {
      const input = c.req.valid("json");
      return c.json(
        await current().runs(
          input.scope_epoch,
          input.automation_id,
          input.limit,
        ),
      );
    },
  );
}
