import { z } from "zod";
import { factReasonSchema, propertyValueSchema } from "./observations";

export const roomAnalysisLimits = {
  rooms: 50,
  concurrent: 2,
  mergeMs: 1500,
  maxWaitMs: 5000,
  cooldownMs: 30_000,
  timeoutMs: 90_000,
  maxAgeMs: 10 * 60_000,
  changeAgeMs: 60_000,
  changes: 20,
  facts: 64,
  contextBytes: 24 * 1024,
  responseBytes: 12 * 1024,
  queueBytes: 512 * 1024,
} as const;

const shortText = z.string().max(256);
const valueSchema = propertyValueSchema.refine(
  (value) => typeof value !== "string" || value.length <= 256,
  "Property text exceeds the analysis limit",
);
export const analysisFactSchema = z.object({
  id: z.string().max(16),
  device_id: z.string().max(512),
  device: shortText,
  online: z.boolean(),
  siid: z.number().int().positive(),
  piid: z.number().int().positive(),
  property: shortText,
  type: shortText.nullable(),
  service: shortText.nullable(),
  value: valueSchema,
  value_label: shortText.nullable(),
  unit: shortText.nullable(),
  reason: factReasonSchema,
  observed_at: z.iso.datetime().nullable(),
  received_at: z.iso.datetime(),
  expires_at: z.iso.datetime().nullable(),
  observation_id: z.uuid(),
});
export const analysisChangeSchema = z.object({
  id: z.uuid(),
  device_id: z.string().max(512),
  device: shortText,
  siid: z.number().int().positive(),
  piid: z.number().int().positive(),
  property: shortText,
  before: valueSchema,
  after: valueSchema,
  at: z.iso.datetime(),
  observation_id: z.uuid(),
});
export const roomContextSchema = z.object({
  scope_epoch: z.uuid(),
  room_id: z.string().max(128).nullable(),
  room: shortText,
  captured_at: z.iso.datetime(),
  policy_version: z.string().max(64),
  trigger: z.enum(["manual", "changes"]),
  facts: z.array(analysisFactSchema).max(roomAnalysisLimits.facts),
  changes: z.array(analysisChangeSchema).max(roomAnalysisLimits.changes),
  coverage: z.object({
    devices: z.number().int().nonnegative(),
    properties: z.number().int().nonnegative(),
    included: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
    unconfirmed: z.number().int().nonnegative(),
    truncated: z.boolean(),
    changes_truncated: z.boolean(),
    independent_events: z.literal("unsupported"),
  }),
});

const citationSchema = z.array(z.string().max(64)).min(1).max(12);
export const roomInterpretationSchema = z.object({
  summary: z.object({
    text: z.string().min(1).max(800),
    evidence: citationSchema,
  }),
  unknowns: z.array(z.string().min(1).max(256)).max(8),
});
export const analysisUsageSchema = z.object({
  model: z.string().max(256),
  input_tokens: z.number().int().nonnegative().nullable(),
  output_tokens: z.number().int().nonnegative().nullable(),
  duration_ms: z.number().nonnegative(),
});
export const analysisRequestSchema = z.object({
  run_id: z.uuid(),
  context: roomContextSchema,
});
export const analysisResponseSchema = z.object({
  run_id: z.uuid(),
  interpretation: roomInterpretationSchema,
  usage: analysisUsageSchema,
});
export const roomAnalysisQuerySchema = z.strictObject({
  scope_epoch: z.uuid(),
  room_id: z.string().max(128).nullable(),
});
export const roomAnalysisStateSchema = roomAnalysisQuerySchema.extend({
  status: z.enum([
    "idle",
    "queued",
    "running",
    "ready",
    "stale",
    "error",
    "unavailable",
  ]),
  message: z.string().max(512).nullable(),
  updated_at: z.iso.datetime(),
  pending_changes: z.number().int().nonnegative(),
  automatic_properties: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  latest: analysisResponseSchema
    .extend({
      context: roomContextSchema,
      completed_at: z.iso.datetime(),
      stale_reason: z.string().max(256).nullable(),
    })
    .nullable(),
  attempt: analysisRequestSchema.nullable(),
});

/** Display prose uses Chinese observations, not readings, identifiers or code. */
export function isObservationDescription(text: string) {
  const normalized = text.normalize("NFKC");
  return (
    !/[\p{N}\p{Script=Latin}_=<>`{}[\]\\%°]/u.test(normalized) &&
    !/(?:百分之|千分之)|[零〇一二两三四五六七八九十百千万亿]{2,}|[零〇一二两三四五六七八九十百千万亿点负正]+\s*(?:摄氏|华氏|度|勒克斯|开尔文|微克|毫克|克|帕|伏|瓦|安培|赫兹|秒|分钟|小时|台|项|次|个百分点)/u.test(
      normalized,
    )
  );
}

/** Validate both evidence references and the observation-only presentation boundary. */
export function validateInterpretation(
  input: z.infer<typeof roomContextSchema>,
  output: z.infer<typeof roomInterpretationSchema>,
) {
  const ids = new Set(
    [...input.facts, ...input.changes].map((item) => item.id),
  );
  return (
    output.summary.evidence.every((id) => ids.has(id)) &&
    [output.summary.text, ...output.unknowns].every(isObservationDescription)
  );
}
