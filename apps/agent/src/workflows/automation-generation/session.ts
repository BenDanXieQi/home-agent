import { attempt } from "es-toolkit";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  automationDefinitionSchema,
  validateAutomationCapabilities,
} from "@home-agent/api/automations";
import { AppError } from "@home-agent/api/errors";
import { z } from "zod";
import { submitConversationInput } from "../../conversation/submit";
import type { WorkflowDependencies } from "../definition";
import {
  AutomationGenerationDoc,
  AutomationGenerationExtension,
  automationDraftSubmissionSchema,
  automationGenerationPromptName,
  automationGenerationAgentName,
} from "./extension";
import type { automationGenerationInputSchema } from "./workflow";

export const automationDraftSchema = automationDraftSubmissionSchema
  .omit({ definition_json: true })
  .extend({ definition: automationDefinitionSchema.nullable() });

const generationFailureDraft = automationDraftSchema.parse({
  definition: null,
  behavior: "本次未能生成有效的规则草稿，已有配置没有修改。请重试生成。",
  clarifications: [],
});

export async function generateAutomationDraft(
  { harness, model }: Pick<WorkflowDependencies, "harness" | "model">,
  input: z.infer<typeof automationGenerationInputSchema>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();

  await using conversation = await harness.createConversation(
    {
      agentName: automationGenerationAgentName,
      prompt: {
        name: automationGenerationPromptName,
        systemVariables: {
          definition_schema: JSON.stringify(
            z.toJSONSchema(automationDefinitionSchema),
          ),
        },
      },
      ownership: { kind: "ownerless" },
      agent: {
        model: { provider: model.provider, modelId: model.id },
        extensions: [AutomationGenerationExtension],
      },
    },
    withAbortSignal(signal, BACKGROUND_CONTEXT),
  );

  return await conversation.withTraceContext(async () => {
    const modelInput = JSON.stringify({
      ...input,
      capabilities: formatCapabilitiesForModel(input.capabilities),
    });
    await submitConversationInput(conversation, modelInput, signal);

    const draft = await conversation.commit(
      async (tx) => {
        const { draft: submission } = await tx.doc(
          AutomationGenerationDoc,
          conversation.id,
        );
        if (!submission) throw new AppError("agent_execution_failed");

        return readAutomationDraft(submission);
      },
      withAbortSignal(signal, BACKGROUND_CONTEXT),
    );
    if (!draft) return generationFailureDraft;

    const problems = draft.definition
      ? validateAutomationCapabilities(draft.definition, input.capabilities)
      : [];
    return automationDraftSchema.parse(
      finalizeAutomationDraft(draft, problems),
    );
  });
}

function readAutomationDraft(arguments_: unknown) {
  const envelope = automationDraftSubmissionSchema.safeParse(arguments_);
  if (!envelope.success) return undefined;

  const [error, definition] = attempt(() => {
    const value: unknown =
      envelope.data.definition_json === null
        ? null
        : JSON.parse(envelope.data.definition_json);
    return value;
  });
  if (error) return undefined;

  const parsed = automationDraftSchema.safeParse({
    definition,
    behavior: envelope.data.behavior,
    clarifications: envelope.data.clarifications,
  });
  return parsed.success ? parsed.data : undefined;
}

function finalizeAutomationDraft(
  draft: z.infer<typeof automationDraftSchema>,
  problems: ReturnType<typeof validateAutomationCapabilities>,
) {
  if (problems.length)
    return {
      definition: null,
      behavior: "生成的规则与当前设备能力不一致，尚未形成可保存的草稿。",
      clarifications: problems,
    };

  if (draft.clarifications.length) return { ...draft, definition: null };

  if (!draft.definition)
    return {
      ...draft,
      clarifications: ["请补充需要触发的条件和要执行的动作。"],
    };

  return draft;
}

function formatCapabilitiesForModel(
  capabilities: z.infer<typeof automationGenerationInputSchema>["capabilities"],
) {
  const propertyColumns = [
    "property_key",
    "description",
    "kind",
    "format",
    "operators",
    "options",
    "unit",
    "range",
    "readable",
    "writeable",
  ] as const;
  const actionColumns = ["action_key", "description", "inputs"] as const;

  const properties = Map.groupBy(
    capabilities.properties,
    (item) => item.device_id,
  );
  const actions = Map.groupBy(capabilities.actions, (item) => item.device_id);
  const devices = new Map(
    [...capabilities.properties, ...capabilities.actions].map((item) => [
      item.device_id,
      item.device_name,
    ]),
  );

  return {
    property_columns: propertyColumns,
    action_columns: actionColumns,
    devices: [...devices].map(([device_id, device_name]) => ({
      device_id,
      device_name,
      properties: (properties.get(device_id) ?? []).map((property) =>
        propertyColumns.map((column) => property[column]),
      ),
      actions: (actions.get(device_id) ?? []).map((action) =>
        actionColumns.map((column) => action[column]),
      ),
    })),
    event_types: capabilities.event_types,
    notification: capabilities.notification,
  };
}
