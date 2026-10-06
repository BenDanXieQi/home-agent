import { latestPropertySchema } from "@home-agent/api/observations";
import { z } from "zod";
import {
  automationEventSchema,
  automationPropertyReferenceSchema,
  automationTruthSchema,
  automationInputKindSchema,
} from "@home-agent/api/automations";

export const automationInputSchema = z.object({
  kind: automationInputKindSchema,
  scope_epoch: z.uuid(),
  sequence: z.number().int().nonnegative(),
  at: z.iso.datetime(),
  facts: z.array(latestPropertySchema),
  report: automationPropertyReferenceSchema.nullable(),
  episodes: z.record(
    z.string(),
    z.object({ id: z.uuid(), previous_id: z.uuid().nullable() }),
  ),
  leaves: z.record(
    z.string(),
    z.object({
      truth: automationTruthSchema,
      reason: z.string().nullable(),
      expires_at: z.iso.datetime().nullable().optional(),
    }),
  ),
  event: automationEventSchema.optional(),
});
export const automationStateSchema = z.object({
  scope_epoch: z.uuid(),
  revision: z.number().int().positive(),
  sequence: z.number().int().nonnegative(),
  at: z.iso.datetime(),
  leaves: z.record(
    z.string(),
    z.object({
      truth: automationTruthSchema,
      episode: z.uuid(),
      since: z.iso.datetime().nullable(),
      sustained_fired: z.boolean(),
    }),
  ),
  last_fired_at: z.iso.datetime().nullable(),
  next_at: z.iso.datetime().nullable(),
});
