import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import {
  automationDraftSchema,
  type automationGenerationInputSchema,
  automationGenerationLimits,
  validateAutomationCapabilities,
  type AutomationCapabilities,
} from "@home-agent/api/automations";
import { AppError } from "@home-agent/api/errors";
import { createModel } from "@home-agent/model";
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
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
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

export function createAutomationGeneration(config: Config) {
  const chatModel = createModel(config, {
    streaming: false,
    maxRetries: 0,
    timeout: Math.min(
      config.AGENT_RUN_TIMEOUT_MS,
      automationGenerationLimits.timeoutMs,
    ),
    maxTokens: Math.min(config.AGENT_MAX_OUTPUT_TOKENS, 6144),
  });
  if (!chatModel) return undefined;
  const model = chatModel.withStructuredOutput(modelDraftSchema, {
    name: "draft_automation",
    method: "functionCalling",
    strict: true,
    includeRaw: true,
  });
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
        "langsmith.span.kind": "llm",
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": chatModel.model,
        "gen_ai.system": config.OPENAI_BASE_URL
          ? "openai-compatible"
          : "openai",
      },
      async (span) => {
        span.setAttribute("automation.draft.valid", false);
        if (telemetryStatus().includeContent)
          span.setAttribute("gen_ai.prompt", context);
        const response = await model.invoke(
          [
            new SystemMessage(automationGenerationInstructions),
            new HumanMessage(context),
          ],
          { signal },
        );
        signal.throwIfAborted();
        if (AIMessage.isInstance(response.raw)) {
          const usage = usageSchema.safeParse(response.raw.usage_metadata);
          if (usage.success) {
            span.setAttribute(
              "gen_ai.usage.input_tokens",
              usage.data.input_tokens,
            );
            span.setAttribute(
              "gen_ai.usage.output_tokens",
              usage.data.output_tokens,
            );
          }
        }
        if (
          !AIMessage.isInstance(response.raw) ||
          response.raw.invalid_tool_calls?.length ||
          response.raw.tool_calls?.length !== 1 ||
          response.raw.tool_calls[0]?.name !== "draft_automation" ||
          ["length", "content_filter"].includes(
            String(response.raw.response_metadata.finish_reason),
          ) ||
          ["incomplete", "failed"].includes(
            String(response.raw.response_metadata.status),
          )
        )
          throw new AppError("agent_execution_failed");
        const envelope = modelDraftSchema.safeParse(response.parsed);
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
          span.setAttribute("gen_ai.completion", JSON.stringify(result));
        return result;
      },
    );
  };
}
