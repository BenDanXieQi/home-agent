import { join, resolve as resolvePath } from "node:path";
import { initializeTelemetry } from "@home-agent/observability";
import { loadEnvironment } from "./environment";
import { createDatabase } from "./db";
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
const mijia = new MijiaService({
  readGo2rtcUrl: async () => (await connectionStore.read()).services.go2rtc.url,
  credentialStore,
  homeSelectionStore: database
    ? createHomeSelectionStore(database.db)
    : undefined,
});
void mijia.initialize().catch(() => {
  console.warn("米家初始化失败，请在页面重试恢复登录。");
});
const app = createApp({
  staticRoot: join(import.meta.dir, "public"),
  environment,
  connectionStore,
  mijia,
  readAgentUrl: async () => (await connectionStore.read()).services.agent.url,
});
const server = Bun.serve({
  hostname: environment.BACKEND_HOST,
  port: environment.BACKEND_PORT,
  fetch: app.fetch,
  idleTimeout: 0,
});
console.info(`Home backend listening on ${server.url.toString()}`);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const drained = await Promise.race([
          Promise.all([
            server.stop(),
            mijia.close().catch(() => {
              console.warn(
                "摄像头会话清理未完成；go2rtc 将在租约到期后自动清理。",
              );
            }),
          ]).then(() => true),
          new Promise<false>((resolve) => {
            drainTimer = setTimeout(
              () => resolve(false),
              environment.BACKEND_SHUTDOWN_TIMEOUT_MS,
            );
          }),
        ]);
        if (!drained) {
          console.warn(
            "Backend shutdown: request drain timed out; closing active connections",
          );
          await server.stop(true);
        }
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
