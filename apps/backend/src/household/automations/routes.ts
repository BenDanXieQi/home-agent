import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AppError } from "@home-agent/api/errors";
import {
  errorResponse,
  handleHttpError,
  validateJson,
} from "@home-agent/api/errors/hono";
import { requireLocalAccess } from "@home-agent/api/local-access";
import {
  automationScopeSchema,
  automationCapabilitiesQuerySchema,
  automationListQuerySchema,
  automationReadRequestSchema,
  automationSaveRequestSchema,
  automationDeleteRequestSchema,
  automationEvaluateRequestSchema,
  automationRunsRequestSchema,
} from "@home-agent/api/automations";
import { HouseholdError } from "../errors";
import { householdHttpError } from "../http-errors";
import type { AutomationService } from "./service";

export function createAutomationRoutes(
  port: number,
  service: AutomationService | undefined,
) {
  const app = new Hono();
  app.use(requireLocalAccess([port, 5173], { webEntry: true }));
  app.use(
    bodyLimit({
      maxSize: 128 * 1024,
      onError: (c) => errorResponse(c, new AppError("request_too_large")),
    }),
  );
  app.use(async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.onError((error, c) =>
    handleHttpError(
      error instanceof HouseholdError ? householdHttpError(error) : error,
      c,
    ),
  );
  const current = () => {
    if (!service) throw new AppError("household_storage_unavailable");
    return service;
  };
  return app
    .post("/list", validateJson(automationScopeSchema), async (c) =>
      c.json(await current().list(c.req.valid("json").scope_epoch)),
    )
    .post("/capabilities", validateJson(automationScopeSchema), (c) =>
      c.json(current().capabilities(c.req.valid("json").scope_epoch)),
    )
    .post(
      "/capabilities/query",
      validateJson(automationCapabilitiesQuerySchema),
      (c) => c.json(current().queryCapabilities(c.req.valid("json"))),
    )
    .post("/query", validateJson(automationListQuerySchema), async (c) =>
      c.json(await current().query(c.req.valid("json"))),
    )
    .post("/read", validateJson(automationReadRequestSchema), async (c) => {
      const input = c.req.valid("json");
      return c.json(await current().read(input.scope_epoch, input.id));
    })
    .post("/save", validateJson(automationSaveRequestSchema), async (c) =>
      c.json(await current().save(c.req.valid("json"))),
    )
    .post("/delete", validateJson(automationDeleteRequestSchema), async (c) => {
      const input = c.req.valid("json");
      await current().remove(
        input.scope_epoch,
        input.id,
        input.expected_revision,
      );
      return c.body(null, 204);
    })
    .post("/evaluate", validateJson(automationEvaluateRequestSchema), (c) => {
      const input = c.req.valid("json");
      return c.json(current().evaluate(input.scope_epoch, input.definition));
    })
    .post("/runs", validateJson(automationRunsRequestSchema), async (c) => {
      const input = c.req.valid("json");
      return c.json(
        await current().runs(
          input.scope_epoch,
          input.automation_id,
          input.limit,
        ),
      );
    });
}
