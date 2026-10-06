import { z } from "zod";

const instanceIdSchema = z.int32().positive();
export const propertyAddressSchema = z.object({
  did: z.string().min(1).max(512),
  siid: instanceIdSchema,
  piid: instanceIdSchema,
});
export const propertyValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const factReasonSchema = z.enum([
  "missing",
  "unverified",
  "cloud_cache",
  "baseline",
  "subscription_pending",
  "subscription_failed",
  "disconnected",
  "offline",
  "expired",
  "gap",
  "spec_unknown",
  "spec_changed",
  "invalid_value",
  "clock_changed",
  "stopped",
  "capacity",
  "current",
]);
export const subscriptionStateSchema = z.enum([
  "pending",
  "confirmed",
  "failed",
  "cancelled",
  "unsupported",
]);
const evidenceSchema = z.object({
  observation_id: z.uuid(),
  input_sequence: z.number().int().nonnegative(),
  source_id: z.string(),
  collection_generation: z.string(),
  source: z.enum(["push", "read"]),
  delivery_kind: z.enum(["live", "baseline", "replayed", "unknown"]),
  observed_at: z.iso.datetime().nullable(),
  received_at: z.iso.datetime(),
  read_started_at: z.iso.datetime().nullable(),
  policy_version: z.string(),
  spec_id: z.string().nullable(),
});
export const latestPropertySchema = z.object({
  account_id: z.string(),
  home_id: z.string(),
  device_id: z.string(),
  room_id: z.string().nullable(),
  siid: propertyAddressSchema.shape.siid,
  piid: propertyAddressSchema.shape.piid,
  spec_id: z.string().nullable(),
  description: z.string(),
  type_name: z.string().nullable(),
  service_type_name: z.string().nullable(),
  readable: z.boolean(),
  unit: z.string().nullable(),
  has_value: z.boolean(),
  value: propertyValueSchema,
  reason: factReasonSchema,
  evidence: evidenceSchema.nullable(),
  applied_at: z.iso.datetime().nullable(),
  expires_at: z.iso.datetime().nullable(),
  last_report_at: z.iso.datetime().nullable(),
  last_change_at: z.iso.datetime().nullable(),
  last_read_at: z.iso.datetime().nullable(),
  read_candidate: evidenceSchema
    .extend({ value: propertyValueSchema })
    .nullable(),
});
export const deviceCoverageSchema = z.object({
  account_id: z.string(),
  device_id: z.string(),
  source_id: z.string().nullable(),
  collection_generation: z.string().nullable(),
  properties: subscriptionStateSchema,
  online: subscriptionStateSchema,
  reason: z.string().nullable(),
  independent_events: z.literal("unsupported"),
});
export const sourceHealthSchema = z.object({
  source_id: z.string(),
  collection_generation: z.string(),
  status: z.enum(["connecting", "connected", "closed"]),
  reason: z.string().nullable(),
  updated_at: z.iso.datetime(),
});
export const collectionStatusSchema = z.object({
  status: z.enum(["idle", "running", "paused", "error"]),
  reason: z.string().nullable(),
  policy_version: z.string(),
  accepted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
  gaps: z.number().int().nonnegative(),
  last_gap_at: z.iso.datetime().nullable(),
  capacity_degraded: z.boolean(),
});
export function initialCollectionStatus() {
  return collectionStatusSchema.parse({
    status: "idle",
    reason: null,
    policy_version: "unconfigured",
    accepted: 0,
    rejected: 0,
    dropped: 0,
    gaps: 0,
    last_gap_at: null,
    capacity_degraded: false,
  });
}
export const propertyKey = (
  account: string,
  did: string,
  siid: number,
  piid: number,
) => JSON.stringify([account, did, siid, piid]);
export const propertyReadRequestSchema = z.strictObject({
  scope_epoch: z.uuid(),
  properties: z.array(propertyAddressSchema).min(1).max(100),
});
export const collectionRetrySchema = z.strictObject({ scope_epoch: z.uuid() });
export const propertyReadItemSchema = propertyAddressSchema.extend({
  outcome: z.enum(["applied", "candidate", "unchanged", "failed"]),
  reason: z.string().nullable(),
  observation_id: z.uuid().nullable(),
});

/** Vendor adapters translate into this boundary; domain code never parses MQTT topics. */
const sourceEnvelope = z.object({
  source_id: z.string().min(1).max(128),
  collection_generation: z.string().min(1).max(128),
  received_at: z.iso.datetime(),
});
const observationEnvelope = sourceEnvelope.extend({
  did: propertyAddressSchema.shape.did,
  delivery_kind: evidenceSchema.shape.delivery_kind,
  observed_at: z.iso.datetime().nullable(),
  packet_bytes: z.number().int().nonnegative(),
});
export const householdObservationSchema = z.discriminatedUnion("kind", [
  observationEnvelope.extend({
    kind: z.literal("property"),
    siid: propertyAddressSchema.shape.siid,
    piid: propertyAddressSchema.shape.piid,
    value: propertyValueSchema,
  }),
  observationEnvelope.extend({
    kind: z.literal("online"),
    online: z.boolean(),
  }),
  sourceEnvelope.extend({
    kind: z.literal("connection"),
    status: sourceHealthSchema.shape.status,
    reason: z.string().max(128).nullable(),
  }),
  sourceEnvelope.extend({
    kind: z.literal("subscription"),
    did: propertyAddressSchema.shape.did,
    channel: z.enum(["properties", "online"]),
    status: subscriptionStateSchema,
    reason: z.string().max(128).nullable(),
  }),
  sourceEnvelope.extend({
    kind: z.literal("read"),
    ...propertyAddressSchema.shape,
    value: propertyValueSchema,
    observed_at: z.iso.datetime().nullable(),
    read_started_at: z.iso.datetime().nullable(),
  }),
]);
export type HouseholdObservation = z.infer<typeof householdObservationSchema>;
