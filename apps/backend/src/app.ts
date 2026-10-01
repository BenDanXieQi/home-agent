import type { createMemberRepository } from "./household/members/repository";
import { createMemberRoutes } from "./household/members/routes";
import { createPerceptionRoutes } from "./perception/routes";
import type { createPerceptionService } from "./perception/service";
import { healthSchema } from "@home-agent/api/contracts";
import { currentTraceId, httpTracing } from "@home-agent/observability";
import { Hono } from "hono";
import { AppError } from "@home-agent/api/errors";
import { errorResponse, handleHttpError } from "@home-agent/api/errors/hono";
import { createWebRoutes } from "./web/routes";
import { secureHeaders } from "hono/secure-headers";
import { createChatRoutes } from "./chat/routes";
import type { Environment } from "./environment";
import { createConnectionRoutes } from "./connections/routes";
import type { ConnectionStore } from "./connections/store";
import { createConnectionStatusRoutes } from "./connections/status";
import { createMijiaRoutes } from "./mijia/routes";
import type { HouseholdRuntime } from "./household/runtime";
import type { MijiaService } from "./mijia/service";
import type { DevicePushLogs } from "./household/device-logs";
import type { RoomAnalysisService } from "./room-analysis/service";
import { createRoomAnalysisRoutes } from "./room-analysis/routes";
import { createContextRoutes } from "./household-context/routes";
import type { createContextRepository } from "./household-context/repository";

type AppDependencies = {
  perception: ReturnType<typeof createPerceptionService>;
  staticRoot?: string;
  environment: Pick<Environment, "BACKEND_PORT" | "BACKEND_REQUEST_TIMEOUT_MS">;
  connectionStore: ConnectionStore;
  household: HouseholdRuntime;
  mijiaService: MijiaService;
  deviceLogs: DevicePushLogs;
  roomAnalysis: RoomAnalysisService;
  memberRepository: ReturnType<typeof createMemberRepository> | undefined;
  contextRepository: ReturnType<typeof createContextRepository> | undefined;
  shutdownSignal: AbortSignal;
  readAgentUrl: () => Promise<string>;
};

export function createApp({
  perception,
  staticRoot,
  environment,
  connectionStore,
  household,
  mijiaService,
  deviceLogs,
  roomAnalysis,
  contextRepository,
  memberRepository,
  shutdownSignal,
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
      "/api/household-members",
      createMemberRoutes(environment.BACKEND_PORT, household, memberRepository),
    )
    .route(
      "/api/household-context",
      createContextRoutes(
        environment.BACKEND_PORT,
        household,
        contextRepository,
      ),
    )
    .route(
      "/api/perception",
      createPerceptionRoutes(
        perception,
        environment.BACKEND_PORT,
        shutdownSignal,
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
      createMijiaRoutes(
        environment.BACKEND_PORT,
        household,
        deviceLogs,
        mijiaService,
        shutdownSignal,
      ),
    )
    .route(
      "/api/rooms/analysis",
      createRoomAnalysisRoutes(environment.BACKEND_PORT, roomAnalysis),
    );
  // Unknown API routes must not fall through to the web application's HTML.
  app.all("/api/*", (c) => errorResponse(c, new AppError("not_found")));
  if (staticRoot) app.route("/", createWebRoutes(staticRoot));
  app.notFound((c) => errorResponse(c, new AppError("not_found")));
  app.onError(handleHttpError);
  return routes;
}
