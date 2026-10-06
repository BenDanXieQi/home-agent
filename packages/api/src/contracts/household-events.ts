import { z } from "zod";
import { automationEventSchema } from "./automations";

const referenceId = z.string().trim().min(1).max(512);

export const householdEventEvidenceSchema = z.strictObject({
  kind: z.enum([
    "device_observation",
    "room_analysis",
    "assessment",
    "user_report",
    "rule",
  ]),
  id: referenceId,
  observed_at: z.iso.datetime().nullable(),
});

/** Stable producer identity survives delivery retries and process restarts. */
export const householdEventSubmissionSchema = z.strictObject({
  event: automationEventSchema,
  producer_id: referenceId,
  source_event_id: referenceId,
  summary: z.string().trim().min(1).max(4000),
  evidence: z.array(householdEventEvidenceSchema).min(1).max(64),
});

export const householdEventReceiptSchema =
  householdEventSubmissionSchema.extend({
    accepted_at: z.iso.datetime(),
  });

export const householdEventIdentitySchema = z.union([
  z.strictObject({ id: z.uuid() }),
  z.strictObject({ producer_id: referenceId, source_event_id: referenceId }),
]);

export const householdEventQuerySchema = z.strictObject({
  event_type: automationEventSchema.shape.event_type.optional(),
  event_types: z
    .array(automationEventSchema.shape.event_type)
    .max(20)
    .optional(),
  device_id: automationEventSchema.shape.device_id.optional(),
  occurred_from: z.iso.datetime().optional(),
  occurred_before: z.iso.datetime().optional(),
  cursor: z
    .strictObject({ accepted_at: z.iso.datetime(), id: z.uuid() })
    .optional(),
  limit: z.number().int().min(1).max(100).default(30),
});

export const householdEventPageSchema = z.object({
  items: z.array(householdEventReceiptSchema),
  next_cursor: householdEventQuerySchema.shape.cursor.unwrap().nullable(),
});
