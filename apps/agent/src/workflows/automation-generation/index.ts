import {
  automationDraftSchema,
  type automationGenerationInputSchema,
  automationGenerationLimits,
  validateAutomationCapabilities,
  type AutomationCapabilities,
} from "@home-agent/api/automations";
import { AppError } from "@home-agent/api/errors";
import type { Models } from "@earendil-works/pi-ai";
import type { ConfiguredModel } from "@home-agent/configuration/models";
import { z } from "zod";
import { withSpan, telemetryStatus } from "@home-agent/observability";
import type { Config } from "../../config";
import { automationGenerationInstructions } from "./instructions";

// One explicit model wire format keeps recursive JSON out of tool-argument
// objects. The shared definition remains the only executable configuration.
const modelDraftSchema = automationDraftSchema
  .omit({ definition: true })
  .extend({
    definition_json: z
      .string()
      .max(64 * 1024)
      .nullable()
      .describe("符合所提供规则 schema 的完整 JSON 字符串；有歧义时为 null"),
  });
const invalidDraft = automationDraftSchema.parse({
  definition: null,
  behavior: "本次未能生成有效的规则草稿，已有配置没有修改。请重试生成。",
  clarifications: [],
});

function modelCapabilities(capabilities: AutomationCapabilities) {
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

export function createAutomationGeneration(
  config: Config,
  models: Models,
  model: ConfiguredModel | undefined,
) {
  if (!model) return undefined;
  return async (
    input: z.infer<typeof automationGenerationInputSchema>,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const context = JSON.stringify({
      ...input,
      capabilities: modelCapabilities(input.capabilities),
    });
    if (Buffer.byteLength(context) > automationGenerationLimits.requestBytes)
      throw new AppError("request_too_large");
    return withSpan(
      "automation.generate",
      {
        "automation.model": model.id,
      },
      async (span) => {
        span.setAttribute("automation.draft.valid", false);
        if (telemetryStatus().includeContent)
          span.setAttribute("langfuse.observation.input", context);
        const response = await models.complete(
          model,
          {
            systemPrompt: automationGenerationInstructions,
            messages: [
              { role: "user", content: context, timestamp: Date.now() },
            ],
            tools: [
              {
                name: "draft_automation",
                description: "提交家庭自动化规则草稿及需要澄清的信息",
                parameters: z.toJSONSchema(modelDraftSchema),
                constrainedSampling: { type: "json_schema", strict: "require" },
              },
            ],
          },
          {
            toolChoice: "required",
            samplingParams: { parallel_tool_calls: false },
            maxRetries: 0,
            timeoutMs: Math.min(
              config.AGENT_RUN_TIMEOUT_MS,
              automationGenerationLimits.timeoutMs,
            ),
            maxTokens: Math.min(
              config.AGENT_MAX_OUTPUT_TOKENS,
              model.maxTokens,
              6144,
            ),
            signal,
          },
        );
        signal.throwIfAborted();
        const calls = response.content.filter(
          (block) => block.type === "toolCall",
        );
        const call = calls[0];
        if (
          !["stop", "toolUse"].includes(response.stopReason) ||
          calls.length !== 1 ||
          call?.name !== "draft_automation"
        )
          throw new AppError("agent_execution_failed");
        const envelope = modelDraftSchema.safeParse(call.arguments);
        if (!envelope.success) return invalidDraft;
        let definition: unknown = null;
        if (envelope.data.definition_json !== null) {
          try {
            definition = JSON.parse(envelope.data.definition_json);
          } catch {
            return invalidDraft;
          }
        }
        const parsed = automationDraftSchema.safeParse({
          definition,
          behavior: envelope.data.behavior,
          clarifications: envelope.data.clarifications,
        });
        if (!parsed.success) return invalidDraft;
        const draft = parsed.data;
        const problems = draft.definition
          ? validateAutomationCapabilities(draft.definition, input.capabilities)
          : [];
        const result = automationDraftSchema.parse(
          problems.length
            ? {
                definition: null,
                behavior:
                  "生成的规则与当前设备能力不一致，尚未形成可保存的草稿。",
                clarifications: problems.slice(0, 5),
              }
            : draft.clarifications.length
              ? { ...draft, definition: null }
              : draft.definition
                ? draft
                : {
                    ...draft,
                    clarifications: ["请补充需要触发的条件和要执行的动作。"],
                  },
        );
        span.setAttribute("automation.draft.valid", result.definition !== null);
        span.setAttribute(
          "automation.validation.problem_count",
          problems.length,
        );
        span.setAttribute(
          "automation.clarification.count",
          result.clarifications.length,
        );
        if (telemetryStatus().includeContent)
          span.setAttribute(
            "langfuse.observation.output",
            JSON.stringify(result),
          );
        return result;
      },
    );
  };
}
