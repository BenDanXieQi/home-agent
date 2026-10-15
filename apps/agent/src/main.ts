import { serve } from "bun";
import { once as onceEvent } from "node:events";
import { memo as once, tryit } from "radash";
import { initializeTelemetry } from "@home-agent/observability";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { loadConfig } from "./config";
import { createApp } from "./app";

async function main() {
  const config = loadConfig();
  await using lifecycle = createProcessLifecycle(
    config.AGENT_SHUTDOWN_TIMEOUT_MS,
  );
  const { processResources, signal } = lifecycle;

  processResources.adopt(
    initializeTelemetry("home-agent-assistant"),
    (telemetry) => telemetry.shutdown(),
  );
  processResources.defer(cleanupSessionResources);

  const [error, app] = await tryit(createApp)(config, signal);
  if (error) {
    if (signal.aborted && error === signal.reason) return;
    throw error;
  }
  processResources.use(app);
  if (signal.aborted) return;

  const server = processResources.adopt(
    serve({
      hostname: config.AGENT_HOST,
      port: config.AGENT_PORT,
      fetch: app.fetch,
    }),
    (instance) => instance.stop(),
  );
  console.info(`Home Agent listening on ${server.url.toString()}`);
  await lifecycle.waitForShutdown();
}

function createProcessLifecycle(timeoutMs: number) {
  const processResources = new AsyncDisposableStack();
  const stopping = new AbortController();
  const signals = ["SIGINT", "SIGTERM"] as const;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;

  const startShutdownDeadline = once(() => {
    shutdownTimer = setTimeout(() => {
      console.error(
        `Home Agent shutdown exceeded ${timeoutMs}ms; forcing exit`,
      );
      process.exit(1);
    }, timeoutMs);
  });

  function requestShutdown() {
    startShutdownDeadline();
    stopping.abort();
  }

  for (const signal of signals) process.on(signal, requestShutdown);

  return {
    processResources,
    signal: stopping.signal,
    async waitForShutdown() {
      if (!stopping.signal.aborted) await onceEvent(stopping.signal, "abort");
    },
    async [Symbol.asyncDispose]() {
      startShutdownDeadline();
      try {
        await processResources.disposeAsync();
      } finally {
        clearTimeout(shutdownTimer);
        for (const signal of signals) process.off(signal, requestShutdown);
      }
    },
  };
}

await main().catch((error) => {
  console.error("Failed to run Home Agent", error);
  process.exitCode = 1;
});
