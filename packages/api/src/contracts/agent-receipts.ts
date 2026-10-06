import { deviceCapabilitySchema } from "../domain/devices";
import { z } from "zod";
import {
  agentContextEventSchema,
  agentContextPartsSchema,
  agentContextPolicy,
  agentContextSnapshotSchema,
  agentDevicePropertySchema,
  agentObservationSchema,
  agentSightingSummarySchema,
  agentObservationSourceSchema,
  agentContextDataSchemas,
} from "./agent-context";

const retainedBytes = 64 * 1024 * 1024;
export const agentReceiptPolicy = {
  records: 1000,
  retainedBytes,
  // A retained receipt includes its changes as well as the message and context.
  responseBytes:
    Math.max(retainedBytes, agentContextPolicy.maxSnapshotBytes) + 1024 * 1024,
} as const;

export const agentReceiptQuerySchema = z
  .strictObject({
    journal_id: z.uuid().optional(),
    after_sequence: z
      .string()
      .regex(/^(0|[1-9]\d*)$/)
      .transform(Number)
      .pipe(z.int().nonnegative())
      .optional(),
  })
  .refine(
    (query) =>
      (query.journal_id === undefined) === (query.after_sequence === undefined),
    {
      message: "A receipt position requires both journal_id and after_sequence",
    },
  );

export const agentReceiverConnectionSchema = z.object({
  status: z.enum(["stopped", "connecting", "connected", "disconnected"]),
  synchronized: z.boolean(),
  last_error: z.object({ reason: z.string(), at: z.iso.datetime() }).nullable(),
});
export const agentReceivedContextSchema = agentContextSnapshotSchema.extend({
  context_bytes: z.number().int().nonnegative(),
  connection: agentReceiverConnectionSchema,
  received_at: z.iso.datetime().nullable(),
});
const deviceIdentity = agentDevicePropertySchema.pick({
  account_id: true,
  device_id: true,
});
export const agentReceiptDeviceSchema = deviceIdentity.extend({
  device_name: z.string().nullable(),
  room_name: z.string().nullable(),
});
export const agentReceiptPropertyMetadataSchema =
  agentReceiptDeviceSchema.extend({
    siid: agentDevicePropertySchema.shape.siid,
    piid: agentDevicePropertySchema.shape.piid,
    capability: deviceCapabilitySchema.nullable(),
  });
const bindingMetadata = agentReceiptDeviceSchema
  .pick({ device_name: true })
  .extend({
    target_name:
      agentContextDataSchemas.spatial.shape.spaces.element.shape.name.nullable(),
  });
const propertyValue = agentDevicePropertySchema.pick({
  has_value: true,
  value: true,
  reason: true,
  evidence: true,
  applied_at: true,
  expires_at: true,
  last_report_at: true,
  last_change_at: true,
  last_read_at: true,
  read_candidate: true,
});
function change<S extends z.ZodType, K extends string>(kind: K, value: S) {
  return z.object({
    kind: z.literal(kind),
    key: z.string(),
    before: value.nullable(),
    after: value.nullable(),
  });
}
export const agentReceiptChangeSchema = z.discriminatedUnion("kind", [
  change("property", propertyValue).extend({
    metadata: agentReceiptPropertyMetadataSchema,
  }),
  change("online", z.boolean()).extend({ metadata: agentReceiptDeviceSchema }),
  change(
    "source_health",
    agentContextDataSchemas.device_state.shape.source_health.valueType.omit({
      updated_at: true,
    }),
  ),
  change(
    "device_coverage",
    agentContextDataSchemas.device_state.shape.device_coverage.valueType,
  ).extend({ metadata: agentReceiptDeviceSchema }),
  change(
    "collection",
    agentContextDataSchemas.device_state.shape.collection.shape.collection.omit(
      { accepted: true },
    ),
  ),
  change("observation", agentObservationSchema),
  change("member_sighting", agentSightingSummarySchema),
  change(
    "observation_source",
    agentObservationSourceSchema.omit({ read_at: true }),
  ),
  change("space", agentContextDataSchemas.spatial.shape.spaces.element),
  change("passage", agentContextDataSchemas.spatial.shape.passages.element),
  change(
    "observation_binding",
    agentContextDataSchemas.spatial.shape.observation_bindings.element,
  ).extend({
    metadata: z.object({
      before: bindingMetadata.nullable(),
      after: bindingMetadata.nullable(),
    }),
  }),
  change("member", agentContextDataSchemas.members.shape.members.element),
  change(
    "inventory_device",
    agentContextDataSchemas.household.shape.device.valueType,
  ),
  z.object({
    kind: z.literal("household_metadata"),
    key: z.enum(["household", "home", "room", "specs"]),
    initial: z.boolean(),
  }),
  change(
    "availability",
    z.object({
      status: z.enum(["loading", "ready", "failed", "unavailable", "delta"]),
      reason: z.string().nullable(),
    }),
  ).extend({ key: agentContextPartsSchema.keyof() }),
]);

export const agentReceiptSummarySchema = z.object({
  id: z.uuid(),
  sequence: z.number().int().positive(),
  received_at: z.iso.datetime(),
  kind: z.enum(["initial", "update"]),
  parts: z.array(agentContextPartsSchema.keyof()),
  payload_bytes: z.number().int().nonnegative(),
  context_delta_bytes: z.number().int(),
  context_bytes: z.number().int().nonnegative(),
  synchronized: z.boolean(),
  changes: z.array(agentReceiptChangeSchema),
});
export const agentReceiptSchema = agentReceiptSummarySchema.extend({
  message: agentContextEventSchema.options[0],
  context: agentContextSnapshotSchema,
});
export const agentReceiptIndexSchema = z.object({
  journal_id: z.uuid(),
  scope: agentContextSnapshotSchema.shape.scope,
  connection: agentReceiverConnectionSchema,
  received_at: z.iso.datetime().nullable(),
  heartbeat_at: z.iso.datetime().nullable(),
  total_received: z.number().int().nonnegative(),
  first_retained_sequence: z.number().int().positive(),
  evicted: z.number().int().nonnegative(),
  retained_bytes: z.number().int().nonnegative(),
  receipts: z.array(agentReceiptSummarySchema),
});
export const agentReceiptDetailSchema = z.object({
  journal_id: z.uuid(),
  receipt: agentReceiptSchema,
});
export const agentCurrentContextSchema = z.object({
  journal_id: z.uuid(),
  context: agentReceivedContextSchema,
});
