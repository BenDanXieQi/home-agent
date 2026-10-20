import { z } from "zod";
import { freeze, parseImmutable, produce } from "@home-agent/api/immutable";
import {
  spaceDefinitionSchema,
  passageDefinitionSchema,
  spatialLayoutSchema,
} from "@home-agent/api/spatial";

export const spatialDraftUpdateSchema = z.strictObject({
  operations: z
    .array(
      z.discriminatedUnion("operation", [
        z.strictObject({
          operation: z.literal("add_space"),
          space: spaceDefinitionSchema.omit({ id: true }),
        }),
        z.strictObject({
          operation: z.literal("update_space"),
          space: spaceDefinitionSchema,
        }),
        spaceDefinitionSchema.pick({ id: true }).extend({
          operation: z.literal("remove_space"),
        }),
        z.strictObject({
          operation: z.literal("add_passage"),
          passage: z
            .strictObject(passageDefinitionSchema.shape)
            .omit({ id: true }),
        }),
        z.strictObject({
          operation: z.literal("update_passage"),
          passage: passageDefinitionSchema,
        }),
        z.strictObject({
          operation: z.literal("remove_passage"),
          id: passageDefinitionSchema.shape.id,
        }),
      ]),
    )
    .min(1)
    .describe(
      "按顺序执行的修改，使用当前草稿的 ID 定位对象。新增 ID 由工具生成；创建空间后从返回草稿取得 ID，再提交关联通道。",
    ),
});

const missingSpace = "空间 ID 不存在，请核对当前草稿。";
const missingPassage = "通道 ID 不存在，请核对当前草稿。";

function locate<T extends { id: string }>(
  records: T[],
  id: string,
  missing: string,
) {
  const index = records.findIndex((record) => record.id === id);
  const record = records[index];
  if (!record) throw new Error(missing);
  return { index, record };
}

export function applySpatialDraftOperations(
  operations: z.infer<typeof spatialDraftUpdateSchema>["operations"],
  current: z.infer<typeof spatialLayoutSchema>,
) {
  const base = parseImmutable(spatialLayoutSchema, current);
  const next = produce(base, (draft) => {
    for (const operation of operations) {
      switch (operation.operation) {
        case "add_space": {
          draft.spaces.push({ ...operation.space, id: crypto.randomUUID() });
          break;
        }
        case "update_space": {
          const { record } = locate(
            draft.spaces,
            operation.space.id,
            missingSpace,
          );
          Object.assign(record, operation.space);
          break;
        }
        case "remove_space": {
          const { index } = locate(draft.spaces, operation.id, missingSpace);
          const connected = draft.passages.some(
            (passage) =>
              passage.space_a_id === operation.id ||
              passage.space_b_id === operation.id,
          );
          if (connected)
            throw new Error("请先显式删除或修改关联通道，再删除空间。");
          draft.spaces.splice(index, 1);
          break;
        }
        case "add_passage": {
          draft.passages.push({
            ...operation.passage,
            id: crypto.randomUUID(),
          });
          break;
        }
        case "update_passage": {
          const { record } = locate(
            draft.passages,
            operation.passage.id,
            missingPassage,
          );
          Object.assign(record, operation.passage);
          break;
        }
        case "remove_passage": {
          const { index } = locate(
            draft.passages,
            operation.id,
            missingPassage,
          );
          draft.passages.splice(index, 1);
          break;
        }
      }
    }
  });
  spatialLayoutSchema.parse(next);
  return freeze(next);
}
