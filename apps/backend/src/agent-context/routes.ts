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
import type { createAgentContextService } from "./service";
import type { createMemberActivityRepository } from "../household/identity/activity-repository";
import type { createPerceptionService } from "../perception/service";
import { PerceptionHistoryError } from "../perception/service";
import { createAgentHistoryReader } from "./history";
import { createAgentContextStream } from "./stream";
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
  context: ReturnType<typeof createAgentContextService>,
  sightings: ReturnType<typeof createMemberActivityRepository> | undefined,
  perception: ReturnType<typeof createPerceptionService>,
) {
  const read = createDeviceHistoryReader(household, query, shutdown, timeoutMs);
  const history = createAgentHistoryReader({
    household,
    sightings,
    perception,
    shutdown,
    timeoutMs,
  });
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
      error instanceof HouseholdError
        ? householdHttpError(error)
        : error instanceof PerceptionHistoryError
          ? new AppError("household_unavailable")
          : error,
      c,
    ),
  );
  return app
    .get("/stream", createAgentContextStream(context, shutdown))
    .post("/history", validateJson(agentHistoryQuerySchema), async (c) => {
      c.header("Cache-Control", "no-store");
      const input = c.req.valid("json");
      if (input.kind !== "device_reports")
        return c.json(await history(input, c.req.raw.signal));
      const { kind, ...queryInput } = input;
      const response = await read(queryInput, c.req.raw.signal, (page) =>
        jsonBytes({ ...page, kind }),
      );
      return c.json(agentHistoryResponseSchema.parse({ ...response, kind }));
    });
}
