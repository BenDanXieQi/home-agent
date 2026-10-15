import { createContextSource } from "./context-source";
import { memo as once, sift } from "radash";
import { createAssistant } from "@home-agent/agent/assistant";
import { createAgentRoutes } from "@home-agent/agent/routes";
import type { loadConfig } from "./config";
import { createContextReceiver } from "@home-agent/agent/context/receiver";
import { configureWorkflows } from "@home-agent/agent/workflows/runtime";
import { initializeModels } from "@home-agent/agent/models";

export async function createApp(
  config: ReturnType<typeof loadConfig>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  await using appResources = new AsyncDisposableStack();

  const workflowConfiguration = configureWorkflows(config);
  const modelRefs = sift([
    config.AGENT_MODEL,
    ...workflowConfiguration.modelRefs,
    ...(config.AGENT_SUBAGENT_MODELS ?? []),
  ]);
  const budget = {
    timeoutMs: config.AGENT_RUN_TIMEOUT_MS,
    maxTokens: config.AGENT_MAX_OUTPUT_TOKENS,
  };
  const modelCatalog = await initializeModels({
    modelRefs,
    timeoutMs: budget.timeoutMs,
    signal,
  });
  signal.throwIfAborted();

  const contextSource = createContextSource(config.BACKEND_URL);
  const assistant = appResources.use(
    await createAssistant({
      modelCatalog,
      modelRef: config.AGENT_MODEL,
      subagentModelRefs: config.AGENT_SUBAGENT_MODELS,
      budget,
      signal,
    }),
  );
  signal.throwIfAborted();

  const workflows = appResources.use(
    workflowConfiguration.create({ modelCatalog, budget }),
  );
  const receiver = appResources.use(
    createContextReceiver({
      client: contextSource,
      onScopeChange: workflows.retainScope,
    }),
  );
  const app = createAgentRoutes({
    port: config.AGENT_PORT,
    context: receiver,
    assistant,
    budget,
    workflows,
  });
  receiver.start();

  const ownedResources = appResources.move();
  return {
    fetch: app.fetch,
    [Symbol.asyncDispose]: once(() => ownedResources.disposeAsync()),
  };
}
