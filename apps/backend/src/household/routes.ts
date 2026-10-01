import {
  propertyReadRequestSchema,
  collectionRetrySchema,
} from "@home-agent/api/observations";
import {
  roomFactsQuerySchema,
  selectRoomFacts,
} from "@home-agent/api/household";
import { Hono } from "hono";
import { validateJson } from "@home-agent/api/errors/hono";
import {
  selectHomeSchema,
  refreshDirectorySchema,
} from "@home-agent/api/household";
import type { HouseholdRuntime } from "./runtime";
import { createHouseholdStream } from "./stream";

export function createHouseholdRoutes(runtime: HouseholdRuntime) {
  return new Hono()
    .post("/facts/query", validateJson(roomFactsQuerySchema), (c) =>
      c.json(selectRoomFacts(runtime.snapshot(), c.req.valid("json"))),
    )
    .post(
      "/properties/read",
      validateJson(propertyReadRequestSchema),
      async (c) => {
        const input = c.req.valid("json");
        return c.json(
          await runtime.readProperties(
            input.scope_epoch,
            input.properties,
            c.req.raw.signal,
          ),
        );
      },
    )
    .post("/collection/retry", validateJson(collectionRetrySchema), (c) =>
      c.json(runtime.retryCollection(c.req.valid("json").scope_epoch)),
    )
    .get("/state", (c) => c.json(runtime.snapshot()))
    .get("/diagnostics", (c) => c.json(runtime.diagnostics()))
    .get("/events", createHouseholdStream(runtime))
    .get("/setup/homes", (c) => c.json(runtime.setupHomes()))
    .put("/scope/homes", validateJson(selectHomeSchema), async (c) => {
      const input = c.req.valid("json");
      return c.json(
        await runtime.bindHome(input.scope_epoch, input.home_id),
        202,
      );
    })
    .post("/devices/refresh", validateJson(refreshDirectorySchema), (c) => {
      const input = c.req.valid("json");
      return c.json(
        runtime.requestRefresh(input.scope_epoch, input.target),
        202,
      );
    });
}
