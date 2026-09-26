import { healthSchema } from "@home-agent/api/contracts";
import { currentTraceId, httpTracing } from "@home-agent/observability";
import { Hono } from "hono";
import { AppError } from "@home-agent/api/errors";
import { errorResponse, handleHttpError } from "@home-agent/api/errors/hono";
import { serveStatic } from "hono/bun";
import { secureHeaders } from "hono/secure-headers";
import { createChatRoutes } from "./chat/routes";
import type { Environment } from "./environment";
import { createConnectionRoutes } from "./connections/routes";
import type { ConnectionStore } from "./connections/store";
import { createConnectionStatusRoutes } from "./connections/status";
import { createMijiaRoutes } from "./mijia/routes";
import type { HouseholdRuntime } from "./household/runtime";
import type { DevicePushLogs } from "./household/device-logs";

type AppDependencies = {
  staticRoot?: string;
  environment: Pick<Environment, "BACKEND_PORT" | "BACKEND_REQUEST_TIMEOUT_MS">;
  connectionStore: ConnectionStore;
  household: HouseholdRuntime;
  deviceLogs: DevicePushLogs;
  readAgentUrl: () => Promise<string>;
};

export function createApp({
  staticRoot,
  environment,
  connectionStore,
  household,
  deviceLogs,
  readAgentUrl,
}: AppDependencies) {
  const app = new Hono();
  app.use(httpTracing());
  app.use(async (c, next) => {
    const startedAt = performance.now();
    await next();
    console.info(
      JSON.stringify({
        message: "HTTP request",
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status: c.res.status,
        duration_ms: Math.round(performance.now() - startedAt),
        trace_id: currentTraceId(),
      }),
    );
  });
  app.use(secureHeaders());
  const routes = app
    .get("/api/health", (c) =>
      c.json(
        healthSchema.parse({
          status: "ok",
          service: "home-agent-backend",
          runtime: "bun",
          timestamp: new Date().toISOString(),
        }),
      ),
    )
    .route(
      "/api/config",
      createConnectionRoutes(environment.BACKEND_PORT, connectionStore),
    )
    .route(
      "/api/services",
      createConnectionStatusRoutes(environment.BACKEND_PORT, connectionStore),
    )
    .route(
      "/api/chat",
      createChatRoutes({
        port: environment.BACKEND_PORT,
        timeoutMs: environment.BACKEND_REQUEST_TIMEOUT_MS,
        readAgentUrl,
      }),
    )
    .route(
      "/api/mijia",
      createMijiaRoutes(environment.BACKEND_PORT, household, deviceLogs),
    );
  // Unknown API routes must not fall through to the web application's HTML.
  app.all("/api/*", (c) => errorResponse(c, new AppError("not_found")));
  if (staticRoot) {
    app.get("/*", serveStatic({ root: staticRoot }));
    app.on(
      "GET",
      ["/", "/devices", "/cameras", "/settings", "/device-logs"],
      serveStatic({ path: `${staticRoot}/index.html` }),
    );
  }
  app.notFound((c) => errorResponse(c, new AppError("not_found")));
  app.onError(handleHttpError);
  return routes;
}
