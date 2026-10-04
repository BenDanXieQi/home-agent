import { createSpeechInbox } from "./conversation/speech-inbox";
import { createSpeechDialogueClient } from "./conversation/agent-client";
import { createMemberRepository } from "./household/members/repository";
import { createPerceptionService } from "./perception/service";
import { createPerceptionSources } from "./mijia/perception-source";
import { createAgentHouseholdReset } from "./household/reset-agent";
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
  resetHomeData: createAgentHouseholdReset(readAgentUrl),
  homeSelectionStore: database
    ? createHomeSelectionStore(database.db)
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
household.start();
const deviceLogs = new DevicePushLogs(
  household,
  resolvePath(import.meta.dir, "../../..", "data/mqtt-logs"),
  mijiaService,
);
mijiaService.initialize().catch(() => {
  console.warn("米家初始化失败，请在页面重试恢复登录。");
});
const speechInbox = createSpeechInbox({
  instanceId: crypto.randomUUID(),
  analyze: createSpeechDialogueClient(readAgentUrl),
});
const perception = createPerceptionService({
  speechInbox,
  configPath: resolvePath(
    import.meta.dir,
    "../../..",
    "config/perception.json",
  ),
  executable: environment.PERCEPTION_FFMPEG_PATH,
  sources: createPerceptionSources(household, mijiaService),
});
perception.start().catch((error: unknown) => {
  console.error("Perception startup failed", error);
});
const shutdown = new AbortController();
const { RoomAnalysisService } = await import("./room-analysis/service");
const { createRoomAnalysisClient } =
  await import("./room-analysis/agent-client");
const roomAnalysis = new RoomAnalysisService(
  household,
  createRoomAnalysisClient(readAgentUrl),
);
const app = createApp({
  speechInbox,
  memberRepository: database ? createMemberRepository(database.db) : undefined,
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
  roomAnalysis,
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
    roomAnalysis.close();
    (async () => {
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const results = await Promise.race([
          Promise.allSettled([
            server.stop(),
            perception.close(),
            app.closeRecordings(),
            speechInbox.close(),
            deviceLogs.stop("后端停止", "interrupted"),
            household.close(),
          ]),
          new Promise<null>((resolve) => {
            drainTimer = setTimeout(
              () => resolve(null),
              environment.BACKEND_SHUTDOWN_TIMEOUT_MS,
            );
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
