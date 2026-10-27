import { createHost } from "@earendil-works/chord";
import {
  createContextSource,
  createMediaReader,
  createAnalysisWriter,
} from "./context-source";
import { memoize, compact } from "es-toolkit";
import { configureAssistant } from "@home-agent/agent/assistant";
import {
  AgentRuntime,
  getServiceInstance,
  registerAgentRuntime,
} from "@home-agent/agent/runtime";
import { createAgentRoutes } from "@home-agent/agent/routes";
import type { loadConfig } from "./config";
import { createContextReceiver } from "@home-agent/agent/context/receiver";
import { createContextReader } from "@home-agent/agent/context/reader";
import { configureWorkflows } from "@home-agent/agent/workflows/runtime";
import { AgentModels, registerAgentModels } from "@home-agent/agent/models";
import { createMediaAnalysisAgent } from "@home-agent/agent/media-analysis";
import { createMediaAnalyzer } from "@home-agent/agent/media-analysis/analysis";

export async function createApp(
  config: ReturnType<typeof loadConfig>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  await using appResources = new AsyncDisposableStack();

  const workflowConfiguration = configureWorkflows(config);
  const modelRefs = compact([
    config.AGENT_MODEL,
    config.AGENT_MEDIA_ANALYSIS_MODEL,
    ...workflowConfiguration.modelRefs,
    ...(config.AGENT_SUBAGENT_MODELS ?? []),
  ]);
  const services = appResources.adopt(
    createHost({ name: "home-agent", self: "home-agent" }),
    (host) => host.close(),
  );
  registerAgentModels(services, { modelRefs, signal });
  const models = await services.get(AgentModels, {}, { signal });
  appResources.defer(() => models.release());
  const modelRuntime = getServiceInstance(models);

  const contextSource = createContextSource(config.BACKEND_URL);
  const receiver = createContextReceiver({
    client: contextSource,
    onReset: () => {
      mediaAnalysisAgent?.reset();
      return workflows.reset();
    },
    onSynchronized: () => {
      mediaAnalysisAgent?.notify();
    },
  });
  const contextReader = createContextReader({
    client: contextSource,
    receiver,
  });
  const mediaAnalysisModel = modelRuntime.findAvailableModel(
    config.AGENT_MEDIA_ANALYSIS_MODEL,
  );
  if (config.AGENT_MEDIA_ANALYSIS_MODEL && !mediaAnalysisModel)
    throw new Error("Configured media analysis model is unavailable");
  const assistantConfiguration = configureAssistant({
    modelRuntime,
    modelRef: config.AGENT_MODEL,
    subagentModelRefs: config.AGENT_SUBAGENT_MODELS,
  });
  registerAgentRuntime(services, {
    promptConfiguration: config,
    extensions: [
      ...assistantConfiguration.extensions,
      ...workflowConfiguration.extensions,
    ],
    signal,
  });
  const runtimeHandle = await services.get(AgentRuntime, {}, { signal });
  appResources.defer(() => runtimeHandle.release());
  const assistantHandle = await assistantConfiguration.register(
    services,
    signal,
  );
  appResources.defer(() => assistantHandle.release());
  const workflowHandle = await workflowConfiguration.register(
    services,
    contextReader,
    signal,
  );
  appResources.defer(() => workflowHandle.release());
  signal.throwIfAborted();
  const assistant = assistantHandle.instance;
  const workflows = getServiceInstance(workflowHandle);
  const mediaAnalysisAgent = mediaAnalysisModel
    ? createMediaAnalysisAgent({
        readParts: () => receiver.currentParts(),
        contextReader,
        readMedia: createMediaReader(config.BACKEND_URL),
        saveCompleted: createAnalysisWriter(config.BACKEND_URL),
        analyze: createMediaAnalyzer({
          model: mediaAnalysisModel,
          modelCollection: modelRuntime.modelCollection,
          prompts: getServiceInstance(runtimeHandle).prompts,
        }).analyze,
      })
    : undefined;
  if (mediaAnalysisAgent) {
    mediaAnalysisAgent.start();
    appResources.defer(() => mediaAnalysisAgent.close());
  }

  appResources.use(receiver);
  const app = createAgentRoutes({
    port: config.AGENT_PORT,
    context: receiver,
    mediaAnalysis: mediaAnalysisAgent,
    assistant,
    harness: getServiceInstance(runtimeHandle).harness,
    workflows,
  });
  receiver.start();

  const ownedResources = appResources.move();
  return {
    fetch: app.fetch,
    [Symbol.asyncDispose]: memoize(() => ownedResources.disposeAsync()),
  };
}
