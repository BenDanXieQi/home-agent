import {
  createContextSource,
  createMediaReader,
  createCameraMediaReader,
  createAnalysisWriter,
} from "./context-source";
import { memoize, compact } from "es-toolkit";
import { configureAssistant } from "@home-agent/agent/assistant";
import { createAgentRuntime } from "@home-agent/agent/runtime";
import { createAgentRoutes } from "@home-agent/agent/routes";
import { MysqlStorage } from "@home-agent/agent/storage/mysql";
import type { loadConfig } from "./config";
import { createContextReceiver } from "@home-agent/agent/context/receiver";
import { createContextReader } from "@home-agent/agent/context/reader";
import { configureWorkflows } from "@home-agent/agent/workflows/runtime";
import { initializeModelRuntime } from "@home-agent/agent/models";
import { createMediaAnalysisAgent } from "@home-agent/agent/media-analysis";
import { createMediaAnalysisExtension } from "@home-agent/agent/media-analysis/extension";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { AppError } from "@home-agent/api/errors";

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
  const modelRuntime = await initializeModelRuntime({
    modelRefs,
    llamaCpp: config.LLAMA_CPP_BASE_URL
      ? { baseUrl: config.LLAMA_CPP_BASE_URL, apiKey: config.LLAMA_CPP_API_KEY }
      : undefined,
    signal,
  });

  const mediaAnalysisModel = modelRuntime.findAvailableModel(
    config.AGENT_MEDIA_ANALYSIS_MODEL,
  );
  if (config.AGENT_MEDIA_ANALYSIS_MODEL && !mediaAnalysisModel)
    throw new Error("Configured media analysis model is unavailable");
  const mainModel = modelRuntime.findAvailableModel(config.AGENT_MODEL);
  if (config.AGENT_MEDIA_ANALYSIS_MODEL && !mainModel)
    throw new Error("Media analysis requires an available AGENT_MODEL");
  const mediaConfiguration = createMediaAnalysisExtension();
  const assistantConfiguration = configureAssistant({
    modelRuntime,
    modelRef: config.AGENT_MODEL,
    subagentModelRefs: config.AGENT_SUBAGENT_MODELS,
  });
  const runtime = appResources.use(
    await createAgentRuntime({
      modelRuntime,
      promptConfiguration: config,
      openMainStorage: () => MysqlStorage.open(config.AGENT_DATABASE_URL),
      extensions: [
        ...assistantConfiguration.extensions,
        ...workflowConfiguration.extensions,
        mediaConfiguration.extension,
      ],
      signal,
    }),
  );
  const { harness, mainHarness } = runtime;
  const contextSource = createContextSource(config.BACKEND_URL);
  const receiver = createContextReceiver({
    client: contextSource,
    harness: mainHarness,
    onReset: async () => {
      await Promise.all([
        workflows.reset(),
        mediaAnalysisAgent?.reset(),
        mainHarness.resetConversations(BACKGROUND_CONTEXT),
      ]);
    },
    onSynchronized: () => {
      mainHarness.resume();
      mediaAnalysisAgent?.notify();
    },
  });
  const contextReader = createContextReader({
    client: contextSource,
    receiver,
  });
  const assistant = await assistantConfiguration.create(runtime, signal);
  appResources.defer(async () => {
    await assistant?.close();
  });
  const workflows = appResources.adopt(
    await workflowConfiguration.create({
      harness,
      modelRuntime,
      contextReader,
    }),
    (instance) => instance.close(),
  );
  signal.throwIfAborted();
  const mediaAnalysisAgent =
    mediaAnalysisModel && mainModel
      ? createMediaAnalysisAgent({
          harness: mainHarness,
          model: mainModel,
          extension: mediaConfiguration.extension,
          analyze: mediaConfiguration.analyze,
          readParts: () => receiver.currentParts(),
          readMedia: createMediaReader(config.BACKEND_URL),
          readCameraMedia: createCameraMediaReader(config.BACKEND_URL),
          saveCompleted: createAnalysisWriter(config.BACKEND_URL),
        })
      : undefined;
  if (mediaAnalysisAgent && mediaAnalysisModel) {
    mediaConfiguration.configure({
      harness,
      model: {
        provider: mediaAnalysisModel.provider,
        modelId: mediaAnalysisModel.id,
      },
      readInput: mediaAnalysisAgent.readInput,
      onProgress: mediaAnalysisAgent.onProgress,
      emitEvent: (event, requestId, eventSignal) =>
        contextReader.readCurrent(eventSignal, async (currentSignal) => {
          if (!assistant) throw new AppError("model_not_configured");
          await assistant.submit(
            {
              type: "input",
              content: `家庭媒体事件：\n${JSON.stringify(event)}`,
              whenBusy: "followUp",
              requestId,
            },
            withAbortSignal(currentSignal, BACKGROUND_CONTEXT),
          );
        }),
    });
    appResources.defer(() => mediaAnalysisAgent.close());
    await mediaAnalysisAgent.start();
  }

  appResources.use(receiver);
  const app = createAgentRoutes({
    port: config.AGENT_PORT,
    context: receiver,
    contextReader,
    mediaAnalysis: mediaAnalysisAgent,
    assistant,
    harness: mainHarness,
    workflows,
  });
  await receiver.start(signal);

  const ownedResources = appResources.move();
  return {
    fetch: app.fetch,
    [Symbol.asyncDispose]: memoize(() => ownedResources.disposeAsync()),
  };
}
