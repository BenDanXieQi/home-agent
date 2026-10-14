import { createBackendClient } from "@home-agent/backend-client";
import {
  initializeTelemetry,
  tracedFetch,
  observeProvider,
} from "@home-agent/observability";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { modelProviderSettings } from "./models";
import { createAssistant } from "./assistant";
import { createChat } from "./chat";
import { createAgentApp } from "./app";
import { loadConfig } from "./config";
import { createContextReceiver } from "./context/receiver";
import { createWorkflows } from "./workflows";

const telemetry = initializeTelemetry("home-agent-agent");
const config = loadConfig();
const workflowModelIds = {
  "automation-generation": config.AGENT_AUTOMATION_MODEL ?? config.AGENT_MODEL,
  "speech-interpretation": config.AGENT_SPEECH_MODEL ?? config.AGENT_MODEL,
};
const subagentModelIds = [
  config.AGENT_MODEL,
  ...(config.AGENT_SUBAGENT_MODELS ?? []),
];
const settings = modelProviderSettings(
  config,
  [...Object.values(workflowModelIds), ...subagentModelIds].filter(
    (id) => id !== undefined,
  ),
);
const models = createModels();
if (settings) models.setProvider(observeProvider(createProvider(settings)));
const model = settings?.models.find((item) => item.id === config.AGENT_MODEL);
const client = createBackendClient(config.BACKEND_URL, { fetch: tracedFetch });
const receiver = createContextReceiver({ client });
const budget = {
  timeoutMs: config.AGENT_RUN_TIMEOUT_MS,
  maxTokens: config.AGENT_MAX_OUTPUT_TOKENS,
};
const assistant = await createAssistant(models, model, {
  ...budget,
  subagentModels: models
    .getModels(config.AGENT_PROVIDER)
    .filter((item) => subagentModelIds.includes(item.id)),
});
const app = createAgentApp({
  port: config.AGENT_PORT,
  receiver,
  chat: createChat(assistant, budget.timeoutMs),
  runWorkflow: createWorkflows(
    models,
    {
      "automation-generation": settings?.models.find(
        (item) => item.id === workflowModelIds["automation-generation"],
      ),
      "speech-interpretation": settings?.models.find(
        (item) => item.id === workflowModelIds["speech-interpretation"],
      ),
    },
    budget,
  ),
});
const server = await startServer();
async function startServer() {
  try {
    return Bun.serve({
      hostname: config.AGENT_HOST,
      port: config.AGENT_PORT,
      fetch: app.fetch,
    });
  } catch (error) {
    try {
      await assistant?.close();
    } finally {
      await telemetry.shutdown();
    }
    throw error;
  }
}
receiver.start();
console.info(`Home Agent listening on ${server.url.toString()}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    Promise.allSettled([receiver.stop(), server.stop(true), assistant?.close()])
      .then((results) => {
        if (results.some((result) => result.status === "rejected"))
          throw new Error("Failed to stop Home Agent resources");
      })
      .finally(() => telemetry.shutdown())
      .catch(() => {
        console.error("Failed to stop Home Agent");
        process.exitCode = 1;
      });
  });
}
