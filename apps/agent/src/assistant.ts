import { propagateAttributes, startObservation } from "@langfuse/tracing";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  createModels,
  contentText,
  Type,
  type AssistantMessage,
  type Models,
  type Model,
  type Api,
} from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  GenerationTask,
  hook,
  LiveDoc,
  MemoryStorage,
  section,
  wrapTool,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  telemetryStatus,
  recordFailure,
  context as otelContext,
  ROOT_CONTEXT,
  trace,
} from "@home-agent/observability";

export function completeAnswer(message: AssistantMessage | undefined) {
  if (
    !message ||
    message.stopReason !== "stop" ||
    message.content.some((block) => block.type === "toolCall")
  )
    throw new Error("The agent did not produce a complete final answer");
  const answer = contentText(message.content, "");
  if (!answer.trim()) throw new Error("The agent produced an empty answer");
  return answer;
}

export async function createAssistant(
  sourceModels: Models,
  model: Model<Api> | undefined,
  options: {
    timeoutMs: number;
    maxTokens: number;
    subagentModels: ReturnType<Models["getModels"]>;
  },
) {
  if (!model) return undefined;
  const sessionId = randomUUID();
  const timeoutMs = options.timeoutMs;
  const requestMetadata = new WeakMap<AbortSignal, Record<string, string>>();
  const models = createModels();
  for (const provider of sourceModels.getProviders()) {
    models.setProvider({
      ...provider,
      streamSimple: (requestModel, transcript, streamOptions) =>
        otelContext.with(ROOT_CONTEXT, () =>
          propagateAttributes(
            {
              sessionId,
              metadata: streamOptions?.signal
                ? (requestMetadata.get(streamOptions.signal) ?? {})
                : {},
            },
            () =>
              provider.streamSimple(requestModel, transcript, {
                ...streamOptions,
                maxTokens: Math.min(
                  requestModel.maxTokens,
                  options.maxTokens,
                  streamOptions?.maxTokens ?? options.maxTokens,
                ),
              }),
          ),
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
              enum: options.subagentModels.map((item) => item.id),
              description:
                "Model for this subagent. Omit to inherit the parent model.",
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
            const childModel = options.subagentModels.find(
              (item) => item.id === args.model,
            );
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
          trace
            .getActiveSpan()
            ?.setAttribute(
              "langfuse.observation.metadata.childConversationId",
              String(childId),
            );
          await api.details({ conversationId: childId }, context);
          const child = await api.conversation(childId, context);
          if (!child)
            throw new Error("The delegated conversation is unavailable");
          const submission = await child.submit(
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
          const answer = completeAnswer(
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
      name: "generation-observations",
      hooks: [
        hook(GenerationTask, {
          beforeRequest: async (_request, api, context) => {
            const live = await api.snapshot(
              LiveDoc,
              api.conversationId,
              context,
            );
            if (context.abortSignal)
              requestMetadata.set(context.abortSignal, {
                conversationId: String(api.conversationId),
                taskId: String(api.taskId),
                submissionIds: JSON.stringify(live?.run?.inputs ?? []),
              });
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
      name: "tool-observations",
      wraps: registry
        .snapshot()
        .tools()
        .map(({ tool }) =>
          wrapTool(tool, (original) => ({
            ...original,
            execute: async (args, api, context) => {
              const live = await api.snapshot(
                LiveDoc,
                api.conversationId,
                context,
              );
              return otelContext.with(ROOT_CONTEXT, () =>
                propagateAttributes(
                  {
                    sessionId,
                    metadata: {
                      conversationId: String(api.conversationId),
                      taskId: String(api.taskId),
                      submissionIds: JSON.stringify(live?.run?.inputs ?? []),
                    },
                  },
                  async () => {
                    const observation = startObservation(
                      `tool.${original.name}`,
                      {},
                      { asType: "tool" },
                    );
                    const toolSpan = observation.otelSpan;
                    if (
                      toolSpan.isRecording() &&
                      telemetryStatus().includeContent
                    )
                      observation.update({ input: args });
                    try {
                      const signal = AbortSignal.any([
                        ...(context.abortSignal ? [context.abortSignal] : []),
                        AbortSignal.timeout(timeoutMs),
                      ]);
                      const result = await otelContext.with(
                        trace.setSpan(otelContext.active(), toolSpan),
                        () =>
                          original.execute(
                            args,
                            api,
                            withAbortSignal(signal, context),
                          ),
                      );
                      signal.throwIfAborted();
                      const includeContent = telemetryStatus().includeContent;
                      if (result.isError)
                        observation.update({
                          level: "ERROR",
                          statusMessage: includeContent
                            ? result.diagnostics
                                ?.filter((d) => d.severity === "error")
                                .map((d) => d.message)
                                .join("; ") || "Tool failed"
                            : "Tool failed",
                        });
                      if (toolSpan.isRecording() && includeContent)
                        observation.update({
                          output:
                            result.structuredOutput ??
                            result.output ??
                            api.retainedOutput().text,
                          metadata: { diagnostics: result.diagnostics },
                        });
                      return result;
                    } catch (error) {
                      recordFailure(toolSpan, error);
                      if (
                        toolSpan.isRecording() &&
                        telemetryStatus().includeContent
                      )
                        observation.update({
                          output: api.retainedOutput().text,
                        });
                      throw error;
                    } finally {
                      observation.end();
                    }
                  },
                ),
              );
            },
          })),
        ),
    }),
  );
  const workspace = await mkdtemp(join(tmpdir(), "home-agent-"));
  const env = new NodeExecutionEnv({ cwd: workspace });
  async function cleanup() {
    try {
      await env.cleanup(BACKGROUND_CONTEXT);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      env: () => env,
      settings: {
        stream: {
          maxRetries: 0,
          timeoutMs,
        },
        retry: { enabled: false, maxRetries: 0 },
      },
    },
    BACKGROUND_CONTEXT,
  ).catch(async (error) => {
    await cleanup();
    throw error;
  });
  let closing: ReturnType<typeof harness.close> | undefined;
  const close = () =>
    (closing ??= harness.close(BACKGROUND_CONTEXT).finally(cleanup));
  const root = await harness
    .root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: model.provider, modelId: model.id },
        instructions:
          "你是家庭助手，使用用户的语言回答。目前未接入家庭资料、设备、感知、通知或持久记忆。不能声称知道实际家庭状态、已控制设备或已安排提醒。本服务运行期间复用同一主会话，可以结合已有对话继续处理；服务重启后会话清空。",
        cwd: workspace,
      },
    })
    .catch(async (error) => {
      await close();
      throw error;
    });
  return { root, sessionId, close };
}
