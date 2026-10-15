import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memo } from "radash";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { createModels, Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  GenerationTask,
  hook,
  MemoryStorage,
  section,
  ToolTask,
  wrapTool,
  type ModelRef,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  createDurableTracing,
  observeDurableRegistry,
  prepareDurableGeneration,
  prepareDurableTool,
  withDurableModelTrace,
  withDurableToolTrace,
} from "@home-agent/observability/durable";

import { readFinalAnswer } from "../utils/final-answer";
import type { initializeModels } from "../models";

export async function createAssistant({
  modelCatalog,
  modelRef,
  subagentModelRefs,
  budget,
  signal,
}: {
  modelCatalog: Awaited<ReturnType<typeof initializeModels>>;
  modelRef: ModelRef | undefined;
  subagentModelRefs: readonly ModelRef[] | undefined;
  budget: { timeoutMs: number; maxTokens: number };
  signal: AbortSignal;
}) {
  signal.throwIfAborted();
  const startupContext = withAbortSignal(signal, BACKGROUND_CONTEXT);
  const model = modelCatalog.resolve(modelRef);
  if (!model) return undefined;

  const subagentModels = modelCatalog.select([
    modelRef,
    ...(subagentModelRefs ?? []),
  ]);

  // Langfuse session grouping shared by the root and its child conversations.
  const sessionId = randomUUID();
  const timeoutMs = budget.timeoutMs;
  const models = createModels();
  for (const provider of modelCatalog.models.getProviders()) {
    models.setProvider({
      ...provider,
      streamSimple: (requestModel, transcript, streamOptions) =>
        withDurableModelTrace(streamOptions?.signal, transcript, () =>
          provider.streamSimple(requestModel, transcript, {
            ...streamOptions,
            maxTokens: Math.min(
              requestModel.maxTokens,
              budget.maxTokens,
              streamOptions?.maxTokens ?? budget.maxTokens,
            ),
          }),
        ),
    });
  }
  const Subagent = defineExtension({
    name: "subagent",
    tools: [
      defineTool({
        name: "subagent",
        description:
          "Delegate a self-contained task to a subagent and get its answer back. Supply all needed context in task.",
        parameters: Type.Object({
          task: Type.String({ minLength: 1 }),
          model: Type.Optional(
            Type.String({
              enum: [...subagentModels.keys()],
              description:
                "Provider/modelId for this subagent. Omit to inherit the parent model.",
            }),
          ),
        }),
        replay: "safe",
        execute: async (args, api, context) => {
          const childId = await api.commit(async (tx) => {
            const existing = (
              await tx.scanConversations({ ownerTaskId: api.taskId }, 1)
            ).items[0];
            if (existing) return existing.id;
            const childModel =
              args.model === undefined
                ? undefined
                : subagentModels.get(args.model);
            if (args.model !== undefined && !childModel)
              throw new Error("The requested subagent model is not configured");
            const child = await tx.createConversation({
              ownership: { kind: "task", taskId: api.taskId },
            });
            await configure(tx, child.id, {
              ...(childModel
                ? {
                    model: {
                      provider: childModel.provider,
                      modelId: childModel.id,
                    },
                  }
                : {}),
              extensions: { remove: [Subagent] },
            });
            return child.id;
          }, context);
          await api.details({ conversationId: childId }, context);
          const child = await api.conversation(childId, context);
          if (!child)
            throw new Error("The delegated conversation is unavailable");
          await tracing.attach(childId, sessionId);
          const submission = await tracing.submit(
            child,
            {
              type: "input",
              content: args.task,
              requestId: `subagent:${api.taskId}`,
            },
            context,
          );
          const settled = await submission.wait(context);
          if (settled.status !== "done" || settled.type !== "input")
            throw new Error("The delegated task did not complete");
          const entry = await api.commit(
            (tx) => tx.entry(AssistantEntry, settled.answer),
            context,
          );
          const message = entry?.model?.[0];
          const answer = readFinalAnswer(
            message?.role === "assistant" ? message : undefined,
          );
          return {
            output: [{ type: "text" as const, text: answer }],
            details: { conversationId: childId },
          };
        },
      }),
    ],
  });
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "execution-observations",
      hooks: [
        hook(GenerationTask, {
          beforeRequest: async (_request, api, context) => {
            await prepareDurableGeneration(api, context);
          },
        }),
        hook(ToolTask, {
          beforeTool: async (call, api, context) => {
            await prepareDurableTool(call, api, context);
          },
        }),
      ],
    }),
  );
  registry.install(CodingTools);
  registry.install(Subagent);
  registry.install(
    defineExtension({
      name: "workspace",
      sections: [section("cwd", (prompt) => prompt.env?.cwd)],
    }),
  );
  registry.install(
    defineExtension({
      name: "tool-deadlines",
      wraps: registry
        .snapshot()
        .tools()
        .map(({ tool }) =>
          wrapTool(tool, (original) => ({
            ...original,
            execute: (args, api, context) =>
              withDurableToolTrace(api, async () => {
                const toolSignal = AbortSignal.any([
                  ...(context.abortSignal ? [context.abortSignal] : []),
                  AbortSignal.timeout(timeoutMs),
                ]);
                const result = await original.execute(
                  args,
                  api,
                  withAbortSignal(toolSignal, context),
                );
                toolSignal.throwIfAborted();
                return result;
              }),
          })),
        ),
    }),
  );
  await using resources = new AsyncDisposableStack();
  const workspacePath = resources.adopt(
    await mkdtemp(join(tmpdir(), "home-agent-")),
    (path) => rm(path, { recursive: true, force: true }),
  );
  signal.throwIfAborted();
  const env = resources.adopt(
    new NodeExecutionEnv({ cwd: workspacePath }),
    (instance) => instance.cleanup(BACKGROUND_CONTEXT),
  );
  // Keep observers alive until Harness has finished closing.
  const observers = resources.use(new AsyncDisposableStack());
  const harness = resources.adopt(
    await Harness.open(
      new MemoryStorage(),
      {
        models,
        registry: observeDurableRegistry(registry),
        env: () => env,
        settings: {
          stream: {
            maxRetries: 0,
            timeoutMs,
          },
          retry: { enabled: false, maxRetries: 0 },
        },
      },
      startupContext,
    ),
    (instance) => instance.close(BACKGROUND_CONTEXT),
  );
  const tracing = observers.adopt(
    createDurableTracing(harness, "household-assistant"),
    (instance) => instance.close(),
  );
  const root = await harness.root(startupContext, {
    agent: {
      model: { provider: model.provider, modelId: model.id },
      instructions:
        "你是家庭助手，使用用户的语言回答。目前未接入家庭资料、设备、感知、通知或持久记忆。不能声称知道实际家庭状态、已控制设备或已安排提醒。本服务运行期间复用同一主会话，可以结合已有对话继续处理；服务重启后会话清空。",
      cwd: workspacePath,
    },
  });
  signal.throwIfAborted();
  await tracing.attach(root.id, sessionId);
  signal.throwIfAborted();
  const ownedResources = resources.move();
  const close = memo(() => ownedResources.disposeAsync());
  return { root, sessionId, tracing, close, [Symbol.asyncDispose]: close };
}
