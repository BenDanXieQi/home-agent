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
import { createDeviceHistoryReader } from "../household/history/read";
import { jsonBytes } from "../household/config";
import { HouseholdError } from "../household/errors";
import { householdHttpError } from "../household/http-errors";

export function createAgentContextRoutes(
  port: number,
  household: HouseholdRuntime,
  query: ReturnType<typeof createDeviceHistoryQuery> | undefined,
  shutdown: AbortSignal,
  timeoutMs: number,
) {
  const read = createDeviceHistoryReader(household, query, shutdown, timeoutMs);
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
      error instanceof HouseholdError ? householdHttpError(error) : error,
      c,
    ),
  );
  return app.post(
    "/history",
    validateJson(agentHistoryQuerySchema),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const { kind, ...input } = c.req.valid("json");
      const response = await read(input, c.req.raw.signal, (page) =>
        jsonBytes({ ...page, kind }),
      );
      return c.json(agentHistoryResponseSchema.parse({ ...response, kind }));
    },
  );
}
