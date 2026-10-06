import { createBackendClient } from "@home-agent/backend-client";
import { initializeTelemetry, tracedFetch } from "@home-agent/observability";
import { createAssistant } from "./assistant";
import { createChat } from "./chat";
import { createAgentApp } from "./app";
import { loadConfig } from "./config";
import { createContextReceiver } from "./context/receiver";
import { createWorkflows } from "./workflows";

const telemetry = initializeTelemetry("home-agent-agent");
const config = loadConfig();
const client = createBackendClient(config.BACKEND_URL, { fetch: tracedFetch });
const receiver = createContextReceiver({ client });
const app = createAgentApp({
  port: config.AGENT_PORT,
  receiver,
  chat: createChat(createAssistant(config), config),
  runWorkflow: createWorkflows(config),
});
const server = Bun.serve({
  hostname: config.AGENT_HOST,
  port: config.AGENT_PORT,
  fetch: app.fetch,
});
receiver.start();
console.info(`Home Agent listening on ${server.url.toString()}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    Promise.all([receiver.stop(), server.stop(true)])
      .finally(() => telemetry.shutdown())
      .catch(() => {
        console.error("Failed to stop Home Agent");
        process.exitCode = 1;
      });
  });
}
