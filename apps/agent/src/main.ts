import { loadConfig } from "./config";
import { initializeTelemetry } from "@home-agent/observability";
import { createAgentDatabase } from "./db";

const telemetry = initializeTelemetry("home-agent-agent");
const { createApp } = await import("./http/app");

const config = loadConfig();
const databaseUrl = config.AGENT_DATABASE_URL ?? config.DATABASE_URL;
const database = databaseUrl ? createAgentDatabase(databaseUrl) : undefined;
const app = createApp(config, database);
const server = Bun.serve({
  hostname: config.AGENT_HOST,
  port: config.AGENT_PORT,
  fetch: app.fetch,
  // SSE can be silent while the model works; the route enforces its deadline.
  idleTimeout: 0,
});

console.info(`Home Agent listening on ${server.url.toString()}`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const drained = await Promise.race([
          server.stop().then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), 30_000);
          }),
        ]);
        if (!drained) await server.stop(true);
      } finally {
        clearTimeout(timer);
        // Telemetry drains active graph operations before closing their pool.
        try {
          await telemetry.shutdown();
        } finally {
          await database?.close();
        }
      }
    })().catch(() => {
      console.error("Failed to shut down Home Agent cleanly");
      process.exitCode = 1;
    });
  });
}
