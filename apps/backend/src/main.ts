import { createDeviceHistoryQuery } from "./household/history/query";
import { createDeviceHistoryRepository } from "./household/history/repository";
import { createDeviceHistoryService } from "./household/history/service";
import { createAppearanceIdentity } from "./household/identity/appearance";
import { createReferenceEnrollment } from "./household/identity/enrollment";
import { createMemberActivityRepository } from "./household/identity/activity-repository";
import { createMemberActivityService } from "./household/identity/activity-service";
import { createMemberAccess } from "./household/members/access";
import { createIdentityReferences } from "./household/identity/references";
import { createReferenceFiles } from "./household/identity/files";
import { createSpeechInbox } from "./conversation/speech-inbox";
import { createSpeechDialogueInterpreter } from "./conversation/interpret";
import { loadModelConfig } from "@home-agent/model";
import { createMemberRepository } from "./household/members/repository";
import { createSpatialRepository } from "./household/spatial/repository";
import { createSpatialService } from "./household/spatial/service";
import { createPerceptionService } from "./perception/service";
import { createPerceptionSources } from "./mijia/perception-source";
import { join, resolve as resolvePath } from "node:path";
import { initializeTelemetry } from "@home-agent/observability";
import { loadEnvironment } from "./environment";
import { createDatabase } from "./db";
import { createContextRepository } from "./household-context/repository";
import { createCredentialStore } from "./credentials/store";
import { createHomeSelectionStore } from "./mijia/homes/store";
import { readCredentialKey } from "./credentials/key";
import {
  createConnectionStore,
  resolveConnectionConfigPath,
} from "./connections/store";

const environment = loadEnvironment();
const telemetry = initializeTelemetry("home-agent-backend");
const { createApp } = await import("./app");
const { MijiaService } = await import("./mijia/service");
const connectionStore = createConnectionStore(
  resolveConnectionConfigPath(resolvePath(import.meta.dir, "../../..")),
);
try {
  await connectionStore.initialize();
} catch (error) {
  console.warn(
    "服务配置初始化失败；请修复配置文件，相关调用将在下次请求恢复。",
    error instanceof Error ? error.message : "未知错误",
  );
}

const readAgentUrl = async () =>
  (await connectionStore.read()).services.agent.url;

const database = environment.DATABASE_URL
  ? createDatabase(environment.DATABASE_URL)
  : undefined;
let identityEnrollment:
  | ReturnType<typeof createReferenceEnrollment>
  | undefined;
const identityReferences = database
  ? createIdentityReferences(
      database.db,
      createReferenceFiles(
        resolvePath(import.meta.dir, "../../..", "data/identity/references"),
      ),
    )
  : undefined;
await identityReferences?.cleanup();
const cleanupIdentity = async () => {
  await identityReferences?.cleanup();
  await identityEnrollment?.reconcile();
};
const keyPath = resolvePath(
  import.meta.dir,
  "../../..",
  environment.CREDENTIAL_KEY_FILE ?? "config/credentials.key",
);
const credentialStore = database
  ? createCredentialStore(database.db, () => readCredentialKey(keyPath))
  : undefined;
const mijiaService = new MijiaService({
  readGo2rtcUrl: async () => (await connectionStore.read()).services.go2rtc.url,
  credentialStore,
  homeSelectionStore: database
    ? createHomeSelectionStore(database.db, cleanupIdentity, () => {
        identityReferences?.matching.invalidate();
      })
    : undefined,
});
const { createMijiaHousehold, createMijiaSpecificationLoader } =
  await import("./mijia/household");
const { MiotSpecClient } = await import("./mijia/protocols/spec/client");
const { householdLimits } = await import("./household/config");
const { DevicePushLogs } = await import("./mijia/device-logs/service");
const { createHouseholdRepository } = await import("./household/repository");
const { loadCollectionPolicy } = await import("./household/collection-policy");
const collectionPolicy = await loadCollectionPolicy(
  resolvePath(import.meta.dir, "../../..", "config/collection.json"),
);
const household = createMijiaHousehold(
  mijiaService,
  database ? createHouseholdRepository(database.db) : undefined,
  createMijiaSpecificationLoader(
    new MiotSpecClient(householdLimits.specificationResponseBytes),
  ),
  collectionPolicy,
);
const deviceHistoryRepository = database
  ? createDeviceHistoryRepository(database.db)
  : undefined;
const deviceHistory = deviceHistoryRepository
  ? createDeviceHistoryService(household, deviceHistoryRepository)
  : undefined;
household.start();
const deviceLogs = new DevicePushLogs(
  household,
  resolvePath(import.meta.dir, "../../..", "data/mqtt-logs"),
  mijiaService,
);
mijiaService.initialize().catch(() => {
  console.warn("米家初始化失败，请在页面重试恢复登录。");
});
const modelConfig = loadModelConfig();
const interpretSpeech = createSpeechDialogueInterpreter(modelConfig);
const speechInbox = createSpeechInbox({
  instanceId: crypto.randomUUID(),
  ...(interpretSpeech ? { analyze: interpretSpeech } : {}),
});
const perceptionSources = createPerceptionSources(household, mijiaService);
const perception = createPerceptionService({
  identityReferences: identityReferences?.matching,
  ...(identityReferences
    ? {
        appearance: createAppearanceIdentity({
          matching: identityReferences.matching,
        }),
      }
    : {}),
  speechInbox,
  configPath: resolvePath(
    import.meta.dir,
    "../../..",
    "config/perception.json",
  ),
  executable: environment.PERCEPTION_FFMPEG_PATH,
  sources: perceptionSources,
});
const memberActivity = database
  ? createMemberActivityService(
      household,
      perception,
      createMemberActivityRepository(database.db),
    )
  : undefined;
perception.start().catch((error: unknown) => {
  console.error("Perception startup failed", error);
});
const shutdown = new AbortController();
identityEnrollment = identityReferences
  ? createReferenceEnrollment(
      identityReferences,
      perception,
      createMemberAccess(household),
      {
        executable: environment.PERCEPTION_FFMPEG_PATH,
        sources: perceptionSources,
      },
    )
  : undefined;
const app = createApp({
  deviceHistoryQuery: deviceHistoryRepository
    ? createDeviceHistoryQuery(deviceHistoryRepository)
    : undefined,
  spatialService: createSpatialService(
    database ? createSpatialRepository(database.db) : undefined,
    (scope) => {
      const snapshot = household.snapshot();
      const current = snapshot.projection.household.household;
      return household.ready &&
        scope?.account_id === current.account_id &&
        scope?.home_id === current.home_id
        ? Object.values(snapshot.projection.device)
        : [];
    },
  ),
  identityEnrollment,
  identityReferences,
  speechInbox,
  memberRepository: database
    ? createMemberRepository(database.db, cleanupIdentity, () => {
        identityReferences?.matching.invalidate();
      })
    : undefined,
  contextRepository: database
    ? createContextRepository(database.db)
    : undefined,
  perception,
  staticRoot: join(import.meta.dir, "public"),
  recordings: {
    executable: environment.PERCEPTION_FFMPEG_PATH,
    directory: resolvePath(
      import.meta.dir,
      "../../..",
      "data/recording-playback",
    ),
  },
  environment,
  connectionStore,
  household,
  mijiaService,
  deviceLogs,
  shutdownSignal: shutdown.signal,
  readAgentUrl,
});
const server = Bun.serve({
  hostname: environment.BACKEND_HOST,
  port: environment.BACKEND_PORT,
  fetch: app.fetch,
  idleTimeout: 0,
});
console.info(`Home backend listening on ${server.url.toString()}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (shutdown.signal.aborted) return;
    shutdown.abort();
    identityEnrollment?.close();
    (async () => {
      const drain = new AbortController();
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const results = await Promise.race([
          Promise.allSettled([
            server.stop(),
            perception.close(),
            app.closeRecordings(),
            speechInbox.close(),
            deviceLogs.stop("后端停止", "interrupted"),
            (async () => {
              try {
                await Promise.all([
                  memberActivity?.close(drain.signal),
                  deviceHistory?.close(drain.signal),
                ]);
              } finally {
                await household.close();
              }
            })(),
          ]),
          new Promise<null>((resolve) => {
            drainTimer = setTimeout(() => {
              drain.abort(new Error("Backend shutdown deadline exceeded"));
              resolve(null);
            }, environment.BACKEND_SHUTDOWN_TIMEOUT_MS);
          }),
        ]);
        const failures = results?.flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : [],
        );
        if (!results || failures?.length) {
          console.warn(
            "Backend shutdown: cleanup failed or timed out; closing active connections",
          );
          await server.stop(true);
        }
        if (failures?.length)
          throw new AggregateError(failures, "Backend resource cleanup failed");
      } finally {
        clearTimeout(drainTimer);
        try {
          await database?.close();
        } finally {
          await telemetry.shutdown();
        }
      }
    })().catch((error: unknown) => {
      console.error("Failed to stop backend", error);
      process.exitCode = 1;
    });
  });
}
