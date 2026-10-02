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
  householdQueryLimits,
  householdOverviewRequestSchema,
  householdOverviewResponseSchema,
  devicesQueryRequestSchema,
  devicesQueryResponseSchema,
  deviceStateRequestSchema,
  deviceStateResponseSchema,
  membersQueryRequestSchema,
  membersQueryResponseSchema,
} from "@home-agent/api/household-queries";
import { HouseholdError } from "../errors";
import { safeMijiaError } from "../../mijia/errors";
import type { createHouseholdQueries } from "./service";

function bounded<T>(result: T) {
  if (
    Buffer.byteLength(JSON.stringify(result)) >
    householdQueryLimits.responseBytes
  )
    throw new HouseholdError("capacity_exceeded");
  return result;
}

export function createHouseholdQueryRoutes(
  port: number,
  queries: ReturnType<typeof createHouseholdQueries>,
) {
  const app = new Hono();
  app.use(requireLocalAccess([port, 5173], { webEntry: true }));
  app.use(
    bodyLimit({
      maxSize: 4096,
      onError: (c) => errorResponse(c, new AppError("request_too_large")),
    }),
  );
  app.onError((error, c) =>
    handleHttpError(
      error instanceof HouseholdError ? safeMijiaError(error) : error,
      c,
    ),
  );
  return app
    .post(
      "/overview",
      validateJson(householdOverviewRequestSchema),
      async (c) =>
        c.json(
          bounded(
            householdOverviewResponseSchema.parse(
              await queries.overview(c.req.valid("json")),
            ),
          ),
        ),
    )
    .post("/devices", validateJson(devicesQueryRequestSchema), (c) =>
      c.json(
        bounded(
          devicesQueryResponseSchema.parse(
            queries.devices(c.req.valid("json")),
          ),
        ),
      ),
    )
    .post("/device-state", validateJson(deviceStateRequestSchema), (c) =>
      c.json(
        bounded(
          deviceStateResponseSchema.parse(
            queries.deviceState(c.req.valid("json")),
          ),
        ),
      ),
    )
    .post("/members", validateJson(membersQueryRequestSchema), async (c) =>
      c.json(
        bounded(
          membersQueryResponseSchema.parse(
            await queries.members(c.req.valid("json")),
          ),
        ),
      ),
    );
}
