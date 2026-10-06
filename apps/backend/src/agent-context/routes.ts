import { addAbortListener } from "node:events";
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
  agentHistoryQuerySchema,
  agentHistoryResponseSchema,
} from "@home-agent/api/agent-context";
import { deviceHistoryPolicy } from "@home-agent/api/device-history";
import type { HouseholdRuntime } from "../household/runtime";
import type { createDeviceHistoryQuery } from "../household/history/query";
import { accessHousehold } from "../household/access";
import { HouseholdError } from "../household/errors";
import { safeMijiaError } from "../mijia/errors";

export function createAgentContextRoutes(
  port: number,
  household: HouseholdRuntime,
  query: ReturnType<typeof createDeviceHistoryQuery> | undefined,
  shutdown: AbortSignal,
  timeoutMs: number,
) {
  const app = new Hono();
  app.use(requireLocalAccess([port]));
  app.use(
    bodyLimit({
      maxSize: deviceHistoryPolicy.requestBytes,
      onError: (c) => errorResponse(c, new AppError("request_too_large")),
    }),
  );
  app.onError((error, c) =>
    handleHttpError(
      error instanceof HouseholdError ? safeMijiaError(error) : error,
      c,
    ),
  );
  return app.post(
    "/history",
    validateJson(agentHistoryQuerySchema),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const input = c.req.valid("json");
      const access = accessHousehold(household, household.epoch);
      if (
        access.identity.accountId !== input.account_id ||
        access.identity.homeId !== input.home_id
      )
        throw new HouseholdError("stale_session");
      if (!query) throw new HouseholdError("home_storage");
      const signal = AbortSignal.any([
        c.req.raw.signal,
        shutdown,
        AbortSignal.timeout(timeoutMs),
      ]);
      const assertCurrent = () => {
        if (signal.aborted)
          throw new AppError(
            signal.reason instanceof DOMException &&
              signal.reason.name === "TimeoutError"
              ? "agent_timeout"
              : "request_cancelled",
          );
        access.assertCurrent();
      };
      assertCurrent();
      const aborted = Promise.withResolvers<never>();
      const listener = addAbortListener(signal, () => {
        aborted.reject(
          new AppError(
            signal.reason instanceof DOMException &&
              signal.reason.name === "TimeoutError"
              ? "agent_timeout"
              : "request_cancelled",
          ),
        );
      });
      try {
        const response = await Promise.race([
          query(
            { identity: access.identity, assertCurrent, signal },
            input,
            (page) =>
              Buffer.byteLength(
                JSON.stringify({ ...page, kind: "device_reports" }),
              ),
          ),
          aborted.promise,
        ]);
        assertCurrent();
        return c.json(
          agentHistoryResponseSchema.parse({
            ...response,
            kind: "device_reports",
          }),
        );
      } finally {
        listener[Symbol.dispose]();
      }
    },
  );
}
