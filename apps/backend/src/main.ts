import { join, resolve as resolvePath } from "node:path";
import { initializeTelemetry } from "@home-agent/observability";
import { loadEnvironment } from "./environment";
import { createDatabase } from "./db";
import {
  createConnectionStore,
  resolveConnectionConfigPath,
} from "./connections/store";

const environment = loadEnvironment();
const telemetry = initializeTelemetry("home-agent-backend");
const { createApp } = await import("./app");
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
const app = createApp(
  join(import.meta.dir, "public"),
  environment,
  database?.db,
  connectionStore,
);
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
          server.stop().then(() => true),
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
