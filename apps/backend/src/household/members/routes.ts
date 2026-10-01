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
  memberScopeSchema,
  memberSaveSchema,
  memberDeleteSchema,
} from "@home-agent/api/household-members";
import type { HouseholdRuntime } from "../runtime";
import { HouseholdError } from "../errors";
import { safeMijiaError } from "../../mijia/errors";
import type { createMemberRepository } from "./repository";

export function createMemberRoutes(
  port: number,
  household: HouseholdRuntime,
  repository: ReturnType<typeof createMemberRepository> | undefined,
) {
  const app = new Hono();
  app.use(requireLocalAccess([port, 5173]));
  app.use(
    bodyLimit({
      maxSize: 16 * 1024,
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
  function access(scope: string) {
    const current = household.snapshot().projection.household.household;
    const assertCurrent = () => {
      const latest = household.snapshot();
      if (
        latest.scope_epoch !== scope ||
        !household.ready ||
        latest.projection.household.household.account_id !==
          current.account_id ||
        latest.projection.household.household.home_id !== current.home_id
      )
        throw new HouseholdError("stale_session");
    };
    assertCurrent();
    if (!current.account_id || !current.home_id)
      throw new HouseholdError("not_bound");
    if (!repository) throw new HouseholdError("home_storage");
    return {
      repository,
      identity: { accountId: current.account_id, homeId: current.home_id },
      assertCurrent,
    };
  }
  return app
    .post("/list", validateJson(memberScopeSchema), async (c) => {
      const input = c.req.valid("json");
      const context = access(input.scope_epoch);
      return c.json(
        await context.repository.access(
          context.identity,
          context.assertCurrent,
        ),
      );
    })
    .post("/save", validateJson(memberSaveSchema), async (c) => {
      const input = c.req.valid("json");
      const context = access(input.scope_epoch);
      return c.json(
        await context.repository.access(
          context.identity,
          context.assertCurrent,
          input,
        ),
      );
    })
    .post("/delete", validateJson(memberDeleteSchema), async (c) => {
      const input = c.req.valid("json");
      const context = access(input.scope_epoch);
      return c.json(
        await context.repository.access(
          context.identity,
          context.assertCurrent,
          { id: input.id, operation: "delete" },
        ),
      );
    });
}
