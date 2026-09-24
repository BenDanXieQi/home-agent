import { join } from "node:path";
import { initializeTelemetry } from "@home-agent/observability";
import { loadConfig } from "./config";
import { createDatabase } from "./db";

const config = loadConfig();
const telemetry = initializeTelemetry("home-agent-backend");
const { createApp } = await import("./app");

const database = config.DATABASE_URL
  ? createDatabase(config.DATABASE_URL)
  : undefined;
const app = createApp(join(import.meta.dir, "public"), config, database?.db);
const server = Bun.serve({
  hostname: config.BACKEND_HOST,
  port: config.BACKEND_PORT,
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
              config.BACKEND_SHUTDOWN_TIMEOUT_MS,
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
