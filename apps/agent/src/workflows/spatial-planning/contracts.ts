import { z } from "zod";
import {
  spaceDefinitionSchema,
  passageDefinitionSchema,
} from "@home-agent/api/spatial";
import { agentContextScopeSchema } from "@home-agent/api/agent-context";

export const spatialDraftSchema = z
  .strictObject({
    spaces: z.array(spaceDefinitionSchema),
    passages: z.array(passageDefinitionSchema),
  })
  .superRefine((draft, ctx) => {
    const spaces = new Set(draft.spaces.map((space) => space.id));
    const passages = new Set(draft.passages.map((passage) => passage.id));
    if (
      spaces.size !== draft.spaces.length ||
      passages.size !== draft.passages.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Draft record IDs must be unique.",
      });
    draft.passages.forEach((passage, index) => {
      for (const endpoint of ["space_a_id", "space_b_id"] as const) {
        if (!spaces.has(passage[endpoint]))
          ctx.addIssue({
            code: "custom",
            path: ["passages", index, endpoint],
            message: "Passage endpoints must refer to draft spaces.",
          });
      }
    });
  });

const imageSchema = z.strictObject({
  type: z.literal("image"),
  mime_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
  data: z.base64().min(1),
});
const session = { session_id: z.uuid() };
export const spatialPlanningInputSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("start"),
    draft: spatialDraftSchema.optional(),
  }),
  z
    .strictObject({
      action: z.literal("message"),
      ...session,
      text: z.string().trim(),
      images: z.array(imageSchema).default([]),
    })
    .refine((input) => input.text.length > 0 || input.images.length > 0, {
      message: "Provide text or an image.",
    }),
  z.strictObject({ action: z.literal("read"), ...session }),
  z.strictObject({ action: z.literal("close"), ...session }),
]);

const household = { scope: agentContextScopeSchema };
export const spatialPlanningRequestSchema = z.discriminatedUnion("action", [
  spatialPlanningInputSchema.options[0].safeExtend(household),
  spatialPlanningInputSchema.options[1].safeExtend(household),
  spatialPlanningInputSchema.options[2].safeExtend(household),
  spatialPlanningInputSchema.options[3].safeExtend(household),
]);

export const spatialPlanningTurnSchema = z.strictObject({
  reply: z.string().trim().min(1),
  questions: z.array(z.string().trim().min(1)),
  draft: spatialDraftSchema,
});
export const spatialPlanningStateSchema = spatialPlanningTurnSchema.extend({
  revision: z.int().nonnegative(),
});
export const spatialPlanningResultSchema = spatialPlanningStateSchema.extend({
  ...session,
  status: z.enum(["idle", "running", "closed"]),
});
