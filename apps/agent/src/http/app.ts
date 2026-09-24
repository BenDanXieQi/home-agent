import { httpTracing, telemetryStatus } from "@home-agent/observability";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { Config } from "../config";
import { createHomeAgent } from "../graph/home-agent";
import { createChatRoutes } from "./chat";
import type { AgentDatabase } from "../db";

export function createApp(config: Config, database?: AgentDatabase) {
  const agent = createHomeAgent(config, database?.checkpointer);
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
  app.route(
    "/api/chat",
    createChatRoutes(agent, config.AGENT_RUN_TIMEOUT_MS, database),
  );
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    return c.json({ error: "internal_server_error" }, 500);
  });
  return app;
}
