import { deviceHistoryTimeSchema } from "./history-time";
import { z } from "zod";
import { deviceValueSchema } from "../domain/devices";

export const provenancePolicy = {
  recordBytes: 64 * 1024,
  queueBytes: 4 * 1024 * 1024,
  queueSubmissions: 256,
  responseBytes: 1024 * 1024,
  defaultLimit: 100,
  maxLimit: 1000,
  retentionDays: 365,
  conversationRetentionDays: 30,
} as const;

const identity = z.string().min(1).max(512);
export const sourceDeliveryKindSchema = z.enum([
  "live",
  "baseline",
  "replayed",
  "unknown",
]);
export const sourceMetadataSchema = z.object({
  collection: z
    .object({
      source_id: z.string(),
      generation: z.string(),
      delivery_kind: sourceDeliveryKindSchema,
      packet_id: z.uuid().nullable(),
    })
    .optional(),
  provider: identity,
  endpoint: identity,
  message_id: z.string().nullable(),
  raw_time: z.union([z.string(), z.number().safe()]).nullable(),
  time_unit: z.enum(["seconds", "milliseconds", "unknown"]).nullable(),
  source_time: z.iso.datetime().nullable(),
  specification: z.string().nullable(),
  model: z.string().nullable().optional(),
  provider_payload: z.record(z.string(), z.unknown()),
  parsing_version: z.literal(1),
  completeness: z.enum(["received_fields", "omitted", "partial"]),
  limitations: z.array(z.string()),
});
export const commandSourceSchema = z
  .object({
    entrypoint: identity,
    executor: z.enum(["automation", "agent", "human", "unknown"]),
    initiator: z.enum(["human", "unknown"]).default("unknown"),
    user_request_id: identity.nullable().default(null),
    rule_id: z.uuid().nullable().default(null),
    rule_revision: z.number().int().positive().nullable().default(null),
    run_id: identity.nullable().default(null),
    action_id: identity.nullable().default(null),
    agent_run_id: identity.nullable().default(null),
    tool_call_id: identity.nullable().default(null),
  })
  .refine(
    (value) => value.initiator !== "human" || value.user_request_id !== null,
    { message: "Human delegation requires an explicit request reference" },
  );
export const commandTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("property"),
    device_id: identity,
    siid: z.number().int().positive(),
    piid: z.number().int().positive(),
    value: deviceValueSchema,
  }),
  z.object({
    kind: z.literal("action"),
    device_id: identity,
    siid: z.number().int().positive(),
    aiid: z.number().int().positive(),
    inputs: z.array(deviceValueSchema),
  }),
]);
export const commandRecordSchema = z.object({
  id: z.uuid(),
  parent_request_id: identity,
  account_id: identity,
  home_id: identity,
  source: commandSourceSchema,
  target: commandTargetSchema,
  called_at: z.iso.datetime(),
  sent_at: z.iso.datetime().nullable(),
  received_at: z.iso.datetime().nullable(),
  outcome: z.enum([
    "provider_succeeded",
    "pending",
    "rejected",
    "unknown",
    "preflight_failed",
  ]),
  provider_code: z.number().int().nullable(),
  endpoint: z.string(),
  response_matches: z.number().int().nonnegative(),
  device_snapshot: z.object({
    name: z.string().nullable(),
    model: z.string().nullable(),
    specification: z.string().nullable(),
    room_id: z.string().nullable(),
  }),
  message: z.string().nullable(),
  output: z.unknown(),
  response: z.unknown(),
  error: z.unknown(),
  completeness: z.enum(["received_fields", "partial", "omitted"]),
  expires_at: z.iso.datetime(),
});
export const materialTopicSchema = z.enum([
  "miot_event",
  "mijia_scene_execution",
  "xiaoai_conversation",
  "mijia_device_history",
]);
const materialBase = z.object({
  room_id: z.string().nullable().optional(),
  account_id: identity,
  home_id: identity,
  source: sourceMetadataSchema,
  model: z.string().nullable(),
});
export const supplierMaterialSchema = z.discriminatedUnion("topic", [
  materialBase.extend({
    topic: z.literal("miot_event"),
    device_id: identity,
    siid: z.number().int().positive(),
    eiid: z.number().int().positive(),
    name: z.string().nullable(),
    arguments: z.array(
      z.object({
        piid: z.number().int().positive(),
        value: z.unknown(),
        description: z.string().nullable(),
      }),
    ),
  }),
  materialBase.extend({
    topic: z.literal("mijia_scene_execution"),
    scene_id: identity,
    execution_id: identity,
    name: z.string().nullable(),
    from: z.unknown(),
    targets: z.array(z.object({ device_id: identity, result: z.unknown() })),
  }),
  materialBase.extend({
    topic: z.literal("xiaoai_conversation"),
    device_id: identity,
    speaker_id: identity,
    hardware: identity,
    request_id: identity,
    query: z.string(),
    answers: z.array(z.unknown()),
    illegal_content: z.unknown(),
    bit_set: z.unknown(),
  }),
  materialBase.extend({
    topic: z.literal("mijia_device_history"),
    device_id: identity,
    record_id: identity,
    query: z.record(z.string(), z.unknown()),
    record: z.record(z.string(), z.unknown()),
  }),
]);
export const provenanceQuerySchema = z
  .strictObject({
    scope_epoch: z.uuid(),
    start: deviceHistoryTimeSchema,
    end: deviceHistoryTimeSchema,
    device_id: identity.optional(),
    scene_id: identity.optional(),
    speaker_id: identity.optional(),
    topic: materialTopicSchema.optional(),
    source: identity.optional(),
    time_basis: z.enum(["received", "source"]).default("received"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(provenancePolicy.maxLimit)
      .default(provenancePolicy.defaultLimit),
    cursor: z
      .object({
        at: deviceHistoryTimeSchema,
        id: z.uuid(),
        query_hash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .optional(),
  })
  .refine((input) => input.start < input.end, {
    message: "start must precede end",
  });
export const provenanceReadSchema = z.object({
  scope_epoch: z.uuid(),
  id: z.uuid(),
});
export const collectorDiagnosticSchema = z.object({
  collector: z.string(),
  scope: z.string(),
  status: z.enum([
    "not_attempted",
    "running",
    "missing_credentials",
    "subscription_rejected",
    "unsupported",
    "temporarily_failed",
    "ready",
    "empty",
    "limited",
  ]),
  suspended: z.boolean(),
  query: z.record(z.string(), z.unknown()).nullable(),
  retry_after_at: z.iso.datetime().nullable(),
  records_received: z.number().int().nonnegative(),
  records_saved: z.number().int().nonnegative(),
  records_repeated: z.number().int().nonnegative(),
  last_attempt_at: z.iso.datetime().nullable(),
  last_success_at: z.iso.datetime().nullable(),
  error: z.string().nullable(),
  limitations: z.array(z.string()),
});
const historyCollectionScope = {
  scope_epoch: z.uuid(),
  device_id: identity,
  start: deviceHistoryTimeSchema,
  end: deviceHistoryTimeSchema,
};
export const deviceHistoryCollectionSchema = z
  .discriminatedUnion("api", [
    z.strictObject({
      ...historyCollectionScope,
      api: z.literal("getDeviceData"),
      key: identity,
      type: z.enum(["prop", "event"]),
      limit: z.number().int().min(1).max(1000).default(100),
    }),
    z.strictObject({
      ...historyCollectionScope,
      api: z.literal("getDeviceDataRaw"),
      key: identity,
      type: z.enum(["prop", "store"]),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    z.strictObject({
      ...historyCollectionScope,
      api: z.literal("getUserDeviceLog"),
      limit: z.number().int().min(1).max(50).default(50),
    }),
  ])
  .refine((input) => input.start < input.end, {
    message: "start must precede end",
  });
export const materialRecordSchema = z.object({
  id: z.uuid(),
  kind: z.literal("observation"),
  topic: materialTopicSchema,
  summary: z.string(),
  certainty: z.literal("supported"),
  received_at: z.iso.datetime(),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  data: supplierMaterialSchema,
  evidence: z.array(z.record(z.string(), z.unknown())),
});
export const materialSummarySchema = materialRecordSchema
  .omit({ data: true, evidence: true })
  .extend({
    source_time: z.iso.datetime().nullable(),
    source: z.string(),
    device_id: z.string().nullable(),
    speaker_id: z.string().nullable(),
    scene_id: z.string().nullable(),
    completeness: sourceMetadataSchema.shape.completeness,
  });
export const materialQueryResponseSchema = z.object({
  records: z.array(materialSummarySchema),
  next_cursor: provenanceQuerySchema.shape.cursor.unwrap().nullable(),
  time_basis: provenanceQuerySchema.shape.time_basis,
  complete_history: z.literal(false),
});
export const commandSummarySchema = commandRecordSchema
  .omit({ response: true, output: true, message: true, error: true })
  .extend({
    target: z.discriminatedUnion("kind", [
      commandTargetSchema.options[0].omit({ value: true }),
      commandTargetSchema.options[1].omit({ inputs: true }),
    ]),
  });
export const commandQueryResponseSchema = z.object({
  records: z.array(commandSummarySchema),
  next_cursor: provenanceQuerySchema.shape.cursor.unwrap().nullable(),
  complete_audit: z.literal(false),
});
