import { attempt } from "es-toolkit";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  automationDefinitionSchema,
  automationCapabilitiesSchema,
  validateAutomationCapabilities,
  type AutomationCapabilities,
} from "@home-agent/api/automations";
import { AppError } from "@home-agent/api/errors";
import { z } from "zod";
import { defineWorkflow, type WorkflowDependencies } from "../definition";
import { optionalModelRefSchema } from "../../models";

export const automationDraftSchema = z.object({
  definition: automationDefinitionSchema.nullable(),
  behavior: z.string(),
  clarifications: z.array(z.string()),
});

export const automationGenerationInputSchema = z.strictObject({
  text: z.string().trim().min(1),
  definition: automationDefinitionSchema.optional(),
  capabilities: automationCapabilitiesSchema,
});

export const contract = {
  input: automationGenerationInputSchema,
  progress: z.never(),
  result: automationDraftSchema,
};

export const extensions = [] as const;

export const modelConfiguration = {
  key: "AGENT_AUTOMATION_MODEL",
  schema: optionalModelRefSchema,
} as const;

export const observation = {
  start: () => ({ attributes: { "automation.draft.valid": false } }),
  complete: (result: z.infer<typeof automationDraftSchema>) => ({
    attributes: {
      "automation.draft.valid": result.definition !== null,
      "automation.clarification.count": result.clarifications.length,
    },
  }),
};

function formatCapabilitiesForModel(capabilities: AutomationCapabilities) {
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

export function createWorkflow(context: Parameters<typeof defineWorkflow>[1]) {
  return defineWorkflow(createAutomationGenerationWorkflow, context);
}

function createAutomationGenerationWorkflow({
  model,
  modelCollection,
  prompts,
}: WorkflowDependencies) {
  const modelDraftSchema = automationDraftSchema
    .omit({ definition: true })
    .extend({
      definition_json: z
        .string()
        .nullable()
        .describe("符合所提供规则 schema 的完整 JSON 字符串；有歧义时为 null"),
    });

  const generationFailureDraft = automationDraftSchema.parse({
    definition: null,
    behavior: "本次未能生成有效的规则草稿，已有配置没有修改。请重试生成。",
    clarifications: [],
  });

  function readAutomationDraft(arguments_: unknown) {
    const envelope = modelDraftSchema.safeParse(arguments_);
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

  async function generateDraft(
    input: z.infer<typeof automationGenerationInputSchema>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();

    const modelInput = JSON.stringify({
      ...input,
      capabilities: formatCapabilitiesForModel(input.capabilities),
    });

    const response = await prompts.complete(
      {
        name: "automation-generation",
        systemVariables: {
          definition_schema: JSON.stringify(
            z.toJSONSchema(automationDefinitionSchema),
          ),
        },
        userVariables: { input: modelInput },
        model,
        modelCollection,
        tools: [
          {
            name: "draft_automation",
            parameters: z.toJSONSchema(modelDraftSchema),
            constrainedSampling: {
              type: "json_schema",
              strict: "require",
            },
          },
        ],
      },
      withAbortSignal(signal, BACKGROUND_CONTEXT),
    );

    signal.throwIfAborted();

    const calls = response.content.filter((block) => block.type === "toolCall");
    const [call] = calls;
    if (
      !["stop", "toolUse"].includes(response.stopReason) ||
      calls.length !== 1 ||
      call?.name !== "draft_automation"
    )
      throw new AppError("agent_execution_failed");

    const draft = readAutomationDraft(call.arguments);
    if (!draft) return generationFailureDraft;

    const problems = draft.definition
      ? validateAutomationCapabilities(draft.definition, input.capabilities)
      : [];
    return automationDraftSchema.parse(
      finalizeAutomationDraft(draft, problems),
    );
  }

  return { run: generateDraft };
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
