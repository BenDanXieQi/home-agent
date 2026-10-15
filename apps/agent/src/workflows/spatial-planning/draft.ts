import { z } from "zod";
import { spatialDraftSchema, spatialPlanningTurnSchema } from "./contracts";

const spaceSchema = spatialDraftSchema.shape.spaces.element;
const passageSchema = spatialDraftSchema.shape.passages.element;
const reference = z.string().trim().min(1);

export const spatialDraftUpdateSchema = spatialPlanningTurnSchema.extend({
  draft: z
    .strictObject({
      spaces: z.array(
        spaceSchema.extend({
          id: spaceSchema.shape.id
            .nullable()
            .describe("已有空间的 ID；新增空间填 null。"),
          ref: reference.describe(
            "本次提交内唯一的空间临时引用，例如 room_a。",
          ),
        }),
      ),
      passages: z.array(
        z.strictObject({
          name: passageSchema.shape.name,
          description: passageSchema.shape.description,
          id: passageSchema.shape.id
            .nullable()
            .describe("已有通道的 ID；新增通道填 null。"),
          space_a_ref: reference.describe("端点空间在本次 spaces 中的 ref。"),
          space_b_ref: reference.describe(
            "另一端点空间在本次 spaces 中的 ref。",
          ),
        }),
      ),
    })
    .superRefine((draft, ctx) => {
      const refs = new Set(draft.spaces.map((space) => space.ref));
      if (refs.size !== draft.spaces.length)
        ctx.addIssue({ code: "custom", message: "Space refs must be unique." });
      draft.passages.forEach((passage, index) => {
        for (const endpoint of ["space_a_ref", "space_b_ref"] as const) {
          if (!refs.has(passage[endpoint]))
            ctx.addIssue({
              code: "custom",
              path: ["passages", index, endpoint],
              message: "Passage endpoints must refer to submitted spaces.",
            });
        }
      });
    }),
});

export function resolveSpatialDraft(
  update: z.infer<typeof spatialDraftUpdateSchema>["draft"],
  current: z.infer<typeof spatialDraftSchema>,
) {
  const existingSpaces = new Set(current.spaces.map((space) => space.id));
  const existingPassages = new Set(
    current.passages.map((passage) => passage.id),
  );
  for (const space of update.spaces) {
    if (space.id !== null && !existingSpaces.has(space.id))
      throw new Error("Unknown space ID; use null for a new space.");
  }
  for (const passage of update.passages) {
    if (passage.id !== null && !existingPassages.has(passage.id))
      throw new Error("Unknown passage ID; use null for a new passage.");
  }
  const ids = new Map(
    update.spaces.map((space) => [space.ref, space.id ?? crypto.randomUUID()]),
  );
  return spatialDraftSchema.parse({
    spaces: update.spaces.map(({ ref, id: _id, ...fields }) => ({
      ...fields,
      id: ids.get(ref),
    })),
    passages: update.passages.map(
      ({ space_a_ref, space_b_ref, id, ...fields }) => ({
        ...fields,
        id: id ?? crypto.randomUUID(),
        space_a_id: ids.get(space_a_ref),
        space_b_id: ids.get(space_b_ref),
      }),
    ),
  });
}
