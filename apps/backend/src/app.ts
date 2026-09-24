import { resolve } from "node:path";
import { healthSchema } from "@home-agent/api/contracts";
import { currentTraceId, httpTracing } from "@home-agent/observability";
import { Hono } from "hono";
import { AppError } from "@home-agent/api/errors";
import { errorResponse, handleHttpError } from "@home-agent/api/errors/hono";
import { serveStatic } from "hono/bun";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { createChatRoutes } from "./chat/routes";
import { loadEnvironment } from "./environment";
import type { Database } from "./db";
import type { AppContext } from "./app-context";
import { createConnectionRoutes } from "./connections/routes";
import {
  createConnectionStore,
  resolveConnectionConfigPath,
} from "./connections/store";
import { createConnectionStatusRoutes } from "./connections/status";

export function createApp(
  staticRoot?: string,
  environment = loadEnvironment(),
  database?: Database,
  connectionStore = createConnectionStore(
    resolveConnectionConfigPath(resolve(import.meta.dir, "../../..")),
  ),
) {
  const app = new Hono<AppContext>();
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
  app.route(
    "/api/config",
    createConnectionRoutes(environment, connectionStore),
  );
  app.route(
    "/api/services",
    createConnectionStatusRoutes(environment, connectionStore),
  );
  app.route("/api/chat", createChatRoutes(environment, connectionStore));
  // Unknown API routes must not fall through to the web application's HTML.
  app.all("/api/*", (c) => errorResponse(c, new AppError("not_found")));
  if (staticRoot) {
    app.get("/*", serveStatic({ root: staticRoot }));
    app.get("/", serveStatic({ path: `${staticRoot}/index.html` }));
  }
  app.notFound((c) => errorResponse(c, new AppError("not_found")));
  app.onError(handleHttpError);
  return app;
}
