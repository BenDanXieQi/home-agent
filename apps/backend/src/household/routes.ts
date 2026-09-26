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
    .get("/state", (c) => c.json(runtime.snapshot()))
    .get("/events", createHouseholdStream(runtime))
    .put("/scope/homes", validateJson(selectHomeSchema), (c) => {
      const input = c.req.valid("json");
      return c.json(runtime.selectHome(input.scope_epoch, input.home_id), 202);
    })
    .post("/devices/refresh", validateJson(refreshDirectorySchema), (c) => {
      const input = c.req.valid("json");
      return c.json(
        runtime.requestRefresh(input.scope_epoch, input.target),
        202,
      );
    });
}
