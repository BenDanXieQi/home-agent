import { createAgentReceiverRoutes } from "./agent-context/receiver-routes";
import { createAgentContextRoutes } from "./agent-context/routes";
import type { createAgentContextService } from "./agent-context/service";
import type { createMemberActivityRepository } from "./household/identity/activity-repository";
import type { createDeviceHistoryQuery } from "./household/history/query";
import { createDeviceHistoryRoutes } from "./household/history/routes";
import type { createDeviceHistoryService } from "./household/history/service";
import { createIdentityRoutes } from "./household/identity/routes";
import type { createReferenceEnrollment } from "./household/identity/enrollment";
import type { createIdentityReferences } from "./household/identity/references";
import { createRecordingService } from "./mijia/recordings/service";
import { createRecordingRoutes } from "./mijia/recordings/routes";
import { createSpeechRoutes } from "./conversation/routes";
import type { createSpeechInbox } from "./conversation/speech-inbox";
import type { createMemberRepository } from "./household/members/repository";
import { createMemberRoutes } from "./household/members/routes";
import { createSpatialRoutes } from "./household/spatial/routes";
import { createSpatialService } from "./household/spatial/service";
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
import { createWorkflowRoutes } from "./workflows/routes";
import type { Environment } from "./environment";
import { createConnectionRoutes } from "./connections/routes";
import type { ConnectionStore } from "./connections/store";
import { createConnectionStatusRoutes } from "./connections/status";
import { createMijiaRoutes } from "./mijia/routes";
import type { HouseholdRuntime } from "./household/runtime";
import type { MijiaService } from "./mijia/service";
import { createContextRoutes } from "./household-context/routes";
import type { createContextRepository } from "./household-context/repository";

type AppDependencies = {
  agentContext: ReturnType<typeof createAgentContextService>;
  memberActivityRepository:
    | ReturnType<typeof createMemberActivityRepository>
    | undefined;
  deviceHistory?:
    | Pick<
        ReturnType<typeof createDeviceHistoryService>,
        "subscribe" | "revision"
      >
    | undefined;
  deviceHistoryQuery?: ReturnType<typeof createDeviceHistoryQuery> | undefined;
  spatialService?: ReturnType<typeof createSpatialService>;
  identityEnrollment?: ReturnType<typeof createReferenceEnrollment> | undefined;
  identityReferences?: ReturnType<typeof createIdentityReferences> | undefined;
  speechInbox: ReturnType<typeof createSpeechInbox>;
  perception: ReturnType<typeof createPerceptionService>;
  staticRoot?: string;
  recordings?: Pick<
    Parameters<typeof createRecordingService>[0],
    "directory" | "executable" | "resolveWindow"
  >;
  environment: Pick<Environment, "BACKEND_PORT" | "BACKEND_REQUEST_TIMEOUT_MS">;
  connectionStore: ConnectionStore;
  household: HouseholdRuntime;
  mijiaService: MijiaService;
  memberRepository: ReturnType<typeof createMemberRepository> | undefined;
  contextRepository: ReturnType<typeof createContextRepository> | undefined;
  shutdownSignal: AbortSignal;
  readAgentUrl: () => Promise<string>;
};

export function createApp({
  agentContext,
  memberActivityRepository,
  deviceHistory,
  deviceHistoryQuery,
  spatialService = createSpatialService(undefined, () => []),
  identityEnrollment,
  identityReferences,
  speechInbox,
  perception,
  staticRoot,
  recordings,
  environment,
  connectionStore,
  household,
  mijiaService,
  contextRepository,
  memberRepository,
  shutdownSignal,
  readAgentUrl,
}: AppDependencies) {
  const recordingService = createRecordingService({
    ...recordings,
    household,
    mijia: mijiaService,
    shutdown: shutdownSignal,
    resolveWindow: recordings?.resolveWindow ?? perception.window,
  });
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
      "/api/agent/context",
      createAgentContextRoutes(
        environment.BACKEND_PORT,
        household,
        deviceHistoryQuery,
        shutdownSignal,
        environment.BACKEND_REQUEST_TIMEOUT_MS,
        agentContext,
        memberActivityRepository,
        perception,
      ),
    )
    .route(
      "/api/device-history",
      createDeviceHistoryRoutes(
        environment.BACKEND_PORT,
        household,
        deviceHistoryQuery,
        deviceHistory,
        shutdownSignal,
        environment.BACKEND_REQUEST_TIMEOUT_MS,
      ),
    )
    .route(
      "/api/spatial",
      createSpatialRoutes(environment.BACKEND_PORT, spatialService),
    )
    .route(
      "/api/household-members/references",
      createIdentityRoutes({
        port: environment.BACKEND_PORT,
        household,
        enrollment: identityEnrollment,
        references: identityReferences,
        shutdown: shutdownSignal,
        timeoutMs: environment.BACKEND_REQUEST_TIMEOUT_MS,
      }),
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
      "/api/perception/speech",
      createSpeechRoutes(speechInbox, environment.BACKEND_PORT, shutdownSignal),
    )
    .route(
      "/api/perception",
      createPerceptionRoutes(
        perception,
        environment.BACKEND_PORT,
        shutdownSignal,
        environment.BACKEND_REQUEST_TIMEOUT_MS,
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
      "/api/agent/receipts",
      createAgentReceiverRoutes({
        port: environment.BACKEND_PORT,
        timeoutMs: environment.BACKEND_REQUEST_TIMEOUT_MS,
        readAgentUrl,
      }),
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
      "/api/workflows",
      createWorkflowRoutes({
        port: environment.BACKEND_PORT,
        timeoutMs: environment.BACKEND_REQUEST_TIMEOUT_MS,
        readAgentUrl,
        household,
        shutdownSignal,
      }),
    )
    .route(
      "/api/mijia/recordings",
      createRecordingRoutes(recordingService, environment.BACKEND_PORT),
    )
    .route(
      "/api/mijia",
      createMijiaRoutes(environment.BACKEND_PORT, household, mijiaService),
    );
  // Unknown API routes must not fall through to the web application's HTML.
  app.all("/api/*", (c) => errorResponse(c, new AppError("not_found")));
  if (staticRoot) app.route("/", createWebRoutes(staticRoot));
  app.notFound((c) => errorResponse(c, new AppError("not_found")));
  app.onError(handleHttpError);
  return Object.assign(routes, { closeRecordings: recordingService.close });
}
