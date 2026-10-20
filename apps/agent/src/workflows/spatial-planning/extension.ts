import { z } from "zod";
import {
  defineDoc,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { applySpatialDraftOperations, spatialDraftUpdateSchema } from "./draft";
import { spatialLayoutSchema } from "@home-agent/api/spatial";

export const spatialPlanningPromptName = "spatial-planning";

export const spatialPlanningStateSchema = z.strictObject({
  questions: z.array(z.string().trim().min(1)),
  draft: spatialLayoutSchema,
});

const spatialPlanningQuestionsSchema = spatialPlanningStateSchema.pick({
  questions: true,
});

export const SpatialPlanningDoc = /* @__PURE__ */ defineDoc<
  z.infer<typeof spatialPlanningStateSchema>
>({
  kind: "home.spatial-planning",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    questions: [],
    draft: { spaces: [], passages: [] },
  }),
});

function createSpatialPlanningExtension() {
  return defineExtension({
    name: "spatial-planning",
    tools: [
      defineTool({
        name: "update_spatial_draft",
        description: "placeholder: 修改空间布局草稿的局部内容",
        parameters: z.toJSONSchema(spatialDraftUpdateSchema),
        executionMode: "sequential",
        execute: async (args, api, context) => {
          const planningUpdate = spatialDraftUpdateSchema.parse(args);
          return api.commit(async (tx) => {
            const state = await tx.doc(SpatialPlanningDoc, api.conversationId);
            state.draft = applySpatialDraftOperations(
              planningUpdate.operations,
              state.draft,
            );
            return {
              output: [
                { type: "text" as const, text: JSON.stringify(state.draft) },
              ],
              details: {
                spaceCount: state.draft.spaces.length,
                passageCount: state.draft.passages.length,
              },
            };
          }, context);
        },
      }),
      defineTool({
        name: "update_spatial_questions",
        description:
          "placeholder: 修改完整的待澄清问题列表；没有问题时传空数组。",
        parameters: z.toJSONSchema(spatialPlanningQuestionsSchema),
        replay: "safe",
        executionMode: "sequential",
        execute: async (args, api, context) => {
          const { questions } = spatialPlanningQuestionsSchema.parse(args);
          await api.commit(async (tx) => {
            const state = await tx.doc(SpatialPlanningDoc, api.conversationId);
            state.questions = questions;
          }, context);
          return {
            output: [
              {
                type: "text" as const,
                text: JSON.stringify({ questions }),
              },
            ],
          };
        },
      }),
    ],
  });
}

export const SpatialPlanningExtension =
  /* @__PURE__ */ createSpatialPlanningExtension();
