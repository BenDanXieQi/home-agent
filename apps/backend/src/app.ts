import { healthSchema } from "@home-agent/contracts";
import { currentTraceId, httpTracing } from "@home-agent/observability";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { serveStatic } from "hono/bun";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { createChatRoutes } from "./chat";
import { loadConfig } from "./config";
import type { Database } from "./db";
import type { AppEnv } from "./env";

export function createApp(
  staticRoot?: string,
  config = loadConfig(),
  database?: Database,
) {
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set("db", database);
    await next();
  });
  app.use(httpTracing());
  app.use(
    logger((message) =>
      console.info(JSON.stringify({ message, trace_id: currentTraceId() })),
    ),
  );
  app.use(secureHeaders());
  app.get("/api/health", (c) =>
    c.json(
      healthSchema.parse({
        status: "ok",
        service: "home-agent-backend",
        runtime: "bun",
        timestamp: new Date().toISOString(),
      }),
    ),
  );
  app.route("/api/chat", createChatRoutes(config));
  // Unknown API routes must not fall through to the web application's HTML.
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
  if (staticRoot) {
    app.get("/*", serveStatic({ root: staticRoot }));
    app.get("/", serveStatic({ path: `${staticRoot}/index.html` }));
  }
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    console.error(
      JSON.stringify({
        message: "Backend request failed",
        error: error.name,
        trace_id: currentTraceId(),
      }),
    );
    return c.json({ error: "Internal server error" }, 500);
  });
  return app;
}
