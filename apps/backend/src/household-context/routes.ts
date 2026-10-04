import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AppError } from "@home-agent/api/errors";
import {
  errorResponse,
  handleHttpError,
  validateJson,
} from "@home-agent/api/errors/hono";
import { requireLocalAccess } from "@home-agent/api/local-access";
import { contextBrowseQuerySchema } from "@home-agent/api/household-context";
import type { HouseholdRuntime } from "../household/runtime";
import { HouseholdError } from "../household/errors";
import { safeMijiaError } from "../mijia/errors";
import type { createContextRepository } from "./repository";

export function createContextRoutes(
  port: number,
  household: HouseholdRuntime,
  repository: ReturnType<typeof createContextRepository> | undefined,
) {
  const app = new Hono();
  app.use(requireLocalAccess([port, 5173], { webEntry: true }));
  app.use(
    bodyLimit({
      maxSize: 4096,
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
  return app.post(
    "/browse",
    validateJson(contextBrowseQuerySchema),
    async (c) => {
      const input = c.req.valid("json");
      const current = household.snapshot().projection.household.household;
      const assertCurrent = () => {
        const latest = household.snapshot();
        if (
          latest.scope_epoch !== input.scope_epoch ||
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
      const result = await repository.browse(
        input,
        { accountId: current.account_id, homeId: current.home_id },
        assertCurrent,
      );
      assertCurrent();
      return c.json(result);
    },
  );
}
