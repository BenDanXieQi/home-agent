import {
  local,
  opaque,
  resource,
  type Host,
  type Handle,
} from "@earendil-works/chord";
import { randomUUID } from "node:crypto";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineExtension,
  defineTool,
  section,
  type ModelRef,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";

import { readFinalAnswer } from "../utils/final-answer";
import type { initializeModelRuntime } from "../models";
import { AgentRuntime, getServiceInstance } from "../runtime";
import { PromptBindingDoc } from "../prompts";

const assistantPromptName = "household-assistant";

export function configureAssistant({
  modelRuntime,
  modelRef,
  subagentModelRefs,
}: {
  modelRuntime: Awaited<ReturnType<typeof initializeModelRuntime>>;
  modelRef: ModelRef | undefined;
  subagentModelRefs: readonly ModelRef[] | undefined;
}) {
  const model = modelRuntime.findAvailableModel(modelRef);

  const subagentModels = modelRuntime.selectAvailableModels([
    modelRef,
    ...(subagentModelRefs ?? []),
  ]);

  const sessionId = randomUUID();
  let assistantRuntime: Parameters<typeof createAssistant>[0];

  const subagentExtension = defineExtension({
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
          const { harness } = assistantRuntime;
          const childExtensions = (await api.agent(context)).extensions.filter(
            (extension) => extension.name !== subagentExtension.name,
          );
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

            const parentPromptState = await tx.doc(
              PromptBindingDoc,
              api.conversationId,
            );
            if (!parentPromptState.prompt)
              throw new Error("The parent conversation has no managed prompt");

            const childConversation = await tx.createConversation({
              ownership: { kind: "task", taskId: api.taskId },
            });
            const childPromptState = await tx.doc(
              PromptBindingDoc,
              childConversation.id,
            );
            childPromptState.prompt = parentPromptState.prompt;

            await configure(tx, childConversation.id, {
              ...(childModel
                ? {
                    model: {
                      provider: childModel.provider,
                      modelId: childModel.id,
                    },
                  }
                : {}),
              extensions: childExtensions,
            });
            return childConversation.id;
          }, context);
          const child = await api.conversation(childId, context);
          if (!child)
            throw new Error("The delegated conversation is unavailable");
          await using conversation = await harness.prepareManagedConversation({
            conversation: child,
            agentName: "household-assistant",
            sessionId,
            context,
          });
          await api.details({ conversationId: childId }, context);
          const submission = await conversation.submit(
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
  const extensions = [
    CodingTools,
    subagentExtension,
    defineExtension({
      name: "household-assistant",
      sections: [section("cwd", (prompt) => prompt.env?.cwd)],
    }),
  ];

  async function createAssistant(
    runtime: NonNullable<Handle<typeof AgentRuntime>["instance"]>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (!model) return undefined;
    const startupContext = withAbortSignal(signal, BACKGROUND_CONTEXT);
    const { harness, workspacePath } = runtime;
    assistantRuntime = runtime;
    return harness.root(startupContext, {
      agentName: "household-assistant",
      sessionId,
      prompt: { name: assistantPromptName },
      agent: {
        model: { provider: model.provider, modelId: model.id },
        cwd: workspacePath,
        extensions,
      },
    });
  }

  const Assistant = local("home.agent.assistant", {
    version: 1,
    input: Type.Object({}),
    members: {
      instance: opaque<Awaited<ReturnType<typeof createAssistant>>>(
        "home.agent.assistant@1",
      ),
    },
  });
  return {
    extensions,
    register(host: Host, startupSignal: AbortSignal) {
      host.serve(
        Assistant,
        (_input, _principal, self) => {
          const runtime = self.get(AgentRuntime, {});
          const resources = self.resources({
            assistant: resource({
              rev: 1,
              deps: [runtime],
              open: ({ signal }) => {
                return createAssistant(
                  getServiceInstance(runtime),
                  AbortSignal.any([signal, startupSignal]),
                );
              },
              close: async (assistant) => {
                await assistant?.close();
              },
            }),
          });
          return { instance: self.expose(resources.assistant) };
        },
        { eager: true },
      );
      return host.get(Assistant, {});
    },
  };
}
