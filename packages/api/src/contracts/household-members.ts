import { z } from "zod";

export const memberProfileSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("person"),
      name: z.string().trim().min(1).max(100),
      description: z.string().trim().max(2000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pet"),
      name: z.string().trim().min(1).max(100),
      species: z.string().trim().min(1).max(50),
      description: z.string().trim().max(2000),
    })
    .strict(),
]);
export const memberScopeSchema = z
  .object({
    scope_epoch: z.string().min(1).max(100),
  })
  .strict();
export const memberSaveSchema = memberScopeSchema.extend({
  id: z.uuid(),
  profile: memberProfileSchema,
  operation: z.enum(["create", "update"]),
});
export const memberDeleteSchema = memberScopeSchema.extend({ id: z.uuid() });
export const memberListSchema = z.object({
  members: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(["person", "pet"]),
      name: z.string(),
      species: z.string(),
      description: z.string(),
    }),
  ),
});
