import { z } from "zod";
import { latestPropertySchema } from "./observations";
import {
  automationPropertyReferenceSchema,
  automationAiPredicateSchema,
} from "./automations";

export const automationReviewRequestSchema = z.strictObject({
  request_id: z.uuid(),
  review_id: z.uuid(),
  revision: z.number().int().positive(),
  goal: automationAiPredicateSchema.shape.goal,
  evaluated_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  context: z.strictObject({
    scope_epoch: z.uuid(),
    sequence: z.number().int().nonnegative(),
    facts: z
      .array(
        automationPropertyReferenceSchema.extend({
          evidence_id: z.string().min(1).max(512),
          description: z.string().max(1000),
          latest: latestPropertySchema.nullable(),
        }),
      )
      .max(50),
  }),
});

export const automationReviewResultSchema = z.strictObject({
  judgment: z.boolean().nullable(),
  explanation: z.string().trim().min(1).max(4000),
  supporting_evidence_ids: z.array(z.string().min(1).max(512)).max(80),
});

export const automationReviewResponseSchema = z.strictObject({
  request_id: z.uuid(),
  status: z.enum(["running", "succeeded", "unknown"]),
  result: automationReviewResultSchema.nullable(),
});

export const automationReviewStatusSchema = z.enum([
  "pending",
  "dispatching",
  "running",
  "succeeded",
  "skipped",
  "unknown",
  "failed",
  "cancelled",
]);
export const automationReviewRunSchema = z.object({
  node_id: z.string(),
  request_id: z.uuid(),
  review_id: z.uuid(),
  revision: z.number().int().positive(),
  status: automationReviewStatusSchema,
  reason: z.string().nullable(),
  request: automationReviewRequestSchema.nullable(),
  result: automationReviewResultSchema.nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export const automationReviewRunsQuerySchema = z.strictObject({
  scope_epoch: z.uuid(),
  automation_id: z.uuid(),
  limit: z.number().int().min(1).max(100).default(30),
});
