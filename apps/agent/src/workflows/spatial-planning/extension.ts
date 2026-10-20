import { z } from "zod";
import {
  defineDoc,
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import { applySpatialDraftOperations, spatialDraftUpdateSchema } from "./draft";
import { spatialLayoutSchema } from "@home-agent/api/spatial";

export const spatialPlanningContentSchema = z.strictObject({
  reply: z.string().trim().min(1),
  questions: z.array(z.string().trim().min(1)),
  draft: spatialLayoutSchema,
});

const spatialPlanningQuestionsSchema = spatialPlanningContentSchema.pick({
  questions: true,
});

export function createSpatialPlanningExtension() {
  const SpatialPlanningDoc = defineDoc<
    Omit<z.infer<typeof spatialPlanningContentSchema>, "reply"> & {
      mijiaRooms: Array<string>;
    }
  >({
    kind: "home.spatial-planning",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({
      questions: [],
      mijiaRooms: [],
      draft: { spaces: [], passages: [] },
    }),
  });

  const SpatialPlanningExtension = defineExtension({
    name: "spatial-planning",
    sections: [
      section(
        "spatial_planning",
        () =>
          "根据用户上传的图片与文字，帮助用户整理家庭空间和通道关系。通道表示两个空间之间可以通行，不能仅凭相邻关系推断。" +
          "每轮输入附带的“当前空间规划状态”是该轮开始时已提交的草稿和待澄清问题，作为本轮修改的起点；" +
          "使用 update_spatial_draft tools 修改空间与通道的草稿，新增的空间会由工具自动生成 id, 使用 id 来关联通道与空间。" +
          "使用 update_spatial_questions tools 修改问题列表，问题列表为空表示没有待澄清问题。" +
          "当前图片与用户输入 不足以完全确定空间和通道关系时，必须使用 update_spatial_questions 工具，等待用户回答后再继续修改草稿。" +
          "请遵循现实世界房间划分的常识，比如'玄关'大概率不会是一个独立空间，正常情况下你应该直接无视它 无需向用户提问。" +
          "空间应该以功能性描述description, 面积啥的没有意义",
          { tag: false }
      ),
      section("mijia_rooms", async (input, context) => {
        const state = await input.read.snapshot(
          SpatialPlanningDoc,
          input.conversationId,
          context,
        );
        if (!state) return undefined;
        return (
          "以下是本次会话开始时读取的米家房间参数，作为重要参考数据。" +
          "因为户型图往往不能实际反应用户家里的真实情况，家庭经常会对原始互相做隔断划分等改造，相比之下用户手动在米家里划分的房间更有参考价值。" +
          `\n${JSON.stringify(state.mijiaRooms)}`
        );
      }),
    ],
    tools: [
      defineTool({
        name: "update_spatial_draft",
        description: "修改空间和通道草稿。",
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
        description: "修改完整的待澄清问题列表；没有问题时传空数组。",
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
                text: "问题列表已更新。",
              },
            ],
          };
        },
      }),
    ],
  });

  return { SpatialPlanningDoc, SpatialPlanningExtension };
}
