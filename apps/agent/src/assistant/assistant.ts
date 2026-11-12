import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { Type } from "typebox";
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
import type { createAgentRuntime } from "../runtime";
import { PromptBindingDoc } from "../prompts";

const assistantPromptName = "household-assistant";
export const householdAgentName = "家庭主Agent";

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

  let sessionId: string | undefined;
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
          const parentAgent = await api.agent(context);
          const childExtensions = parentAgent.extensions.filter(
            (extension) => extension.name !== subagentExtension.name,
          );
          const parentPromptState = await api.snapshot(
            PromptBindingDoc,
            api.conversationId,
            context,
          );
          const parentPrompt = parentPromptState?.prompt;
          if (!parentPrompt)
            throw new Error("The parent conversation has no managed prompt");

          const childId = await harness.commit(async (tx) => {
            const childModel =
              args.model === undefined
                ? undefined
                : subagentModels.get(args.model);
            if (args.model !== undefined && !childModel)
              throw new Error("The requested subagent model is not configured");

            const childConversation = await tx.createConversation({
              ownership: { kind: "ownerless" },
            });
            const childPromptState = await tx.doc(
              PromptBindingDoc,
              childConversation.id,
            );
            childPromptState.prompt = parentPrompt;

            const delegatedModel = childModel
              ? { provider: childModel.provider, modelId: childModel.id }
              : parentAgent.model;
            await configure(tx, childConversation.id, {
              ...(delegatedModel ? { model: delegatedModel } : {}),
              ...(parentAgent.cwd ? { cwd: parentAgent.cwd } : {}),
              thinkingLevel: parentAgent.thinkingLevel,
              extensions: childExtensions,
            });
            return childConversation.id;
          }, context);
          const child = await harness.conversation(childId, context);
          if (!child)
            throw new Error("The delegated conversation is unavailable");
          await using conversation = await harness.prepareManagedConversation({
            conversation: child,
            agentName: "家庭子Agent",
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
          const entry = await harness.commit(
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
    runtime: Awaited<ReturnType<typeof createAgentRuntime>>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (!model) return undefined;
    const startupContext = withAbortSignal(signal, BACKGROUND_CONTEXT);
    const { mainHarness, workspacePath } = runtime;
    assistantRuntime = runtime;
    const conversation = await mainHarness.root(startupContext, {
      agentName: householdAgentName,
      prompt: { name: assistantPromptName },
      agent: {
        model: { provider: model.provider, modelId: model.id },
        cwd: workspacePath,
        extensions,
      },
    });
    await conversation.configure(
      {
        model: { provider: model.provider, modelId: model.id },
        cwd: workspacePath,
      },
      startupContext,
    );
    sessionId = conversation.sessionId;
    return conversation;
  }

  return { extensions, create: createAssistant };
}
