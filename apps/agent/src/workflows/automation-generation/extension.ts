import {
  defineDoc,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { z } from "zod";

export const automationGenerationPromptName = "automation-generation";
export const automationGenerationAgentName = "自动化生成Agent";

export const automationDraftSubmissionSchema = z.object({
  behavior: z.string(),
  clarifications: z.array(z.string()),
  definition_json: z
    .string()
    .nullable()
    .describe("符合所提供规则 schema 的完整 JSON 字符串；有歧义时为 null"),
});

export const AutomationGenerationDoc = /* @__PURE__ */ defineDoc<{
  draft: z.infer<typeof automationDraftSubmissionSchema> | null;
}>({
  kind: "home.automation-generation",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ draft: null }),
});

function createAutomationGenerationExtension() {
  return defineExtension({
    name: "automation-generation",
    tools: [
      defineTool({
        name: "draft_automation",
        description: "placeholder: 提交家庭自动化规则草稿及需要澄清的信息",
        parameters: z.toJSONSchema(automationDraftSubmissionSchema),
        constrainedSampling: {
          type: "json_schema",
          strict: "require",
        },
        executionMode: "sequential",
        execute: async (args, api, context) => {
          const draft = automationDraftSubmissionSchema.parse(args);
          await api.commit(async (tx) => {
            const state = await tx.doc(
              AutomationGenerationDoc,
              api.conversationId,
            );
            state.draft = draft;
          }, context);

          return {
            output: [{ type: "text" as const, text: JSON.stringify(draft) }],
            control: { terminate: true },
          };
        },
      }),
    ],
  });
}

export const AutomationGenerationExtension =
  /* @__PURE__ */ createAutomationGenerationExtension();
