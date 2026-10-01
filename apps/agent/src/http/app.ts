import { createHouseholdReset } from "../household-reset";
import { householdResetRequestSchema } from "@home-agent/api/household-reset";
import { validateJson } from "@home-agent/api/errors/hono";
import { httpTracing, telemetryStatus } from "@home-agent/observability";
import { Hono } from "hono";
import { requireLocalAccess } from "@home-agent/api/local-access";
import { AppError } from "@home-agent/api/errors";
import { errorResponse, handleHttpError } from "@home-agent/api/errors/hono";
import { secureHeaders } from "hono/secure-headers";
import type { Config } from "../config";
import { createHomeAgent } from "../graph/home-agent";
import { createChatRoutes } from "./chat";
import type { AgentDatabase } from "../db";
import { createRoomAnalysisAgent } from "../graph/room-analysis";
import { createRoomAnalysisRoutes } from "./room-analysis";

export function createApp(config: Config, database?: AgentDatabase) {
  const agent = createHomeAgent(config, database?.checkpointer);
  const reset = createHouseholdReset(database);
  const app = new Hono();
  app.use(httpTracing());
  app.use(secureHeaders());
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "home-agent",
      runtime: "bun",
      modelConfigured: Boolean(agent),
      persistenceConfigured: Boolean(database),
      tracingEnabled: telemetryStatus().enabled,
      tracingIncludesContent: telemetryStatus().includeContent,
    }),
  );
  app.use("/api/*", requireLocalAccess([config.AGENT_PORT]));
  app.route(
    "/api/chat",
    createChatRoutes(agent, config.AGENT_RUN_TIMEOUT_MS, database, reset),
  );
  app.route(
    "/api/room-analysis",
    createRoomAnalysisRoutes(
      createRoomAnalysisAgent(config),
      config.AGENT_RUN_TIMEOUT_MS,
      reset,
    ),
  );
  app.post(
    "/api/household-reset",
    validateJson(householdResetRequestSchema),
    async (c) => {
      const input = c.req.valid("json");
      if (input.phase === "prepare") await reset.prepare(input.id);
      else reset.finish(input.id);
      return c.body(null, 204);
    },
  );
  app.notFound((c) => errorResponse(c, new AppError("not_found")));
  app.onError(handleHttpError);
  return app;
}
