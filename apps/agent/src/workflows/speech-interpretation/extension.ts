import { z } from "zod";
import {
  defineDoc,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";

export const speechInterpretationPromptName = "speech-interpretation";
export const speechInterpretationAgentName = "语音理解Agent";

export const speechDecisionSchema = z
  .object({
    needsResponse: z.boolean(),
    isComplete: z.boolean(),
    category: z.enum([
      "assistant_request",
      "conversation",
      "media",
      "uncertain",
    ]),
    requestText: z.string().trim().min(1).nullable(),
    reason: z.string().min(1),
  })
  .refine(
    (decision) =>
      decision.needsResponse === (decision.category === "assistant_request") &&
      (decision.requestText !== null) ===
        (decision.needsResponse && decision.isComplete),
    "Inconsistent speech interpretation",
  );

export const SpeechInterpretationDoc = /* @__PURE__ */ defineDoc<{
  decision: z.infer<typeof speechDecisionSchema> | null;
}>({
  kind: "home.speech-interpretation",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ decision: null }),
});

function createSpeechInterpretationExtension() {
  return defineExtension({
    name: "speech-interpretation",
    tools: [
      defineTool({
        name: "interpret_speech",
        description: "placeholder: 提交当前语音片段的请求判断",
        parameters: z.toJSONSchema(speechDecisionSchema),
        constrainedSampling: { type: "json_schema", strict: "require" },
        executionMode: "sequential",
        execute: async (args, api, context) => {
          const decision = speechDecisionSchema.parse(args);
          await api.commit(async (tx) => {
            const state = await tx.doc(
              SpeechInterpretationDoc,
              api.conversationId,
            );
            state.decision = decision;
          }, context);

          return {
            output: [{ type: "text" as const, text: JSON.stringify(decision) }],
            control: { terminate: true },
          };
        },
      }),
    ],
  });
}

export const SpeechInterpretationExtension =
  /* @__PURE__ */ createSpeechInterpretationExtension();
