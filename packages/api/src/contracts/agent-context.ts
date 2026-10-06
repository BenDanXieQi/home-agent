import { z } from "zod";
import { spatialSnapshotSchema } from "./spatial";
import { propertyKey } from "./observations";
import {
  deviceHistoryQuerySchema,
  deviceHistoryResponseSchema,
  deviceHistoryPolicy,
  deviceHistoryTimeSchema,
} from "./device-history";

import {
  projectionSchema,
  deviceSchema,
  specSchema,
  stateVersionSchema,
  changeSchema,
} from "./household";
import { memberListSchema } from "./household-members";
import {
  contextEntityTypeSchema,
  contextEntityRoleSchema,
} from "./household-context";
import { memberActivityDataSchema } from "./perception";
import { windowDetailSchema } from "./perception-window";

/** The shared time schema normalizes UTC to six fractional digits. */
export function agentHistoryTimeDifference(
  value: z.output<typeof deviceHistoryTimeSchema>,
) {
  const milliseconds = Date.parse(value);
  const remainingFractionMs = Number(value.slice(23, 26)) / 1000;
  return (observedMs: number) =>
    observedMs - milliseconds - remainingFractionMs;
}

export const agentContextPolicy = {
  cacheBytes: 16 * 1024 * 1024,
  maxSnapshotBytes: 16 * 1024 * 1024,
  pendingBytes: 16 * 1024 * 1024,
  eventBytes: 16 * 1024 * 1024 + 128,
  partBytes: {
    spatial: 1024 * 1024,
    household: 8 * 1024 * 1024,
    device_state: 2 * 1024 * 1024,
    members: 1024 * 1024,
    observations: 4 * 1024 * 1024,
  },
  recentObservationMs: 30 * 60_000,
  connections: 16,
  heartbeatMs: 15_000,
  heartbeatTimeoutMs: 45_000,
  writeTimeoutMs: 15_000,
  reconnectInitialMs: 1000,
  reconnectMaxMs: 30_000,
  retryInitialMs: 1000,
  retryMaxMs: 30_000,
  historyResponseBytes: deviceHistoryPolicy.responseBytes,
  historyTimeoutMs: 30_000,
} as const;
export const agentContextScopeSchema = z.strictObject({
  account_id: deviceHistoryQuerySchema.shape.account_id,
  home_id: deviceHistoryQuerySchema.shape.home_id,
  scope_epoch: stateVersionSchema.shape.scope_epoch,
});
export const memberSightingRecordSchema = z.object({
  id: z.uuid(),
  kind: z.literal("observation"),
  topic: z.literal("member_sighting"),
  summary: z.string(),
  certainty: z.enum(["supported", "tentative", "unknown", "conflicting"]),
  occurredAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  scopeEpoch: z.string().min(1),
  data: memberActivityDataSchema,
  evidence: z.array(z.record(z.string(), z.json())),
  entities: z.array(
    z.object({
      contextId: z.uuid(),
      entityType: contextEntityTypeSchema,
      entityId: z.string().min(1),
      role: contextEntityRoleSchema,
    }),
  ),
});
export const perceptionWindowHistoryRecordSchema = z.object({
  window: windowDetailSchema,
  matches: z.object({
    visual: z.array(z.object({ window_id: windowDetailSchema.shape.id })),
    audio: z.array(
      z.object({ track_run_id: z.uuid(), generation: z.uuid().nullable() }),
    ),
    speech: z.array(
      z.object({
        id: windowDetailSchema.shape.speech.shape.segments.element.shape.id,
      }),
    ),
  }),
});
export const agentObservationReasonSchema = z.enum([
  "member_sighting",
  "unidentified_target",
  "visual_change",
  "speech",
  "pet_sound",
]);
export const agentObservationSourceSchema = z.object({
  status: z.enum(["loading", "ready", "unavailable", "failed"]),
  read_at: z.iso.datetime().nullable(),
  reason: z.string().nullable(),
  truncated: z.boolean(),
});
export const agentObservationSchema = z.object({
  id: z.uuid(),
  startedAt: z.number(),
  endedAt: z.number(),
  reasons: z.array(agentObservationReasonSchema).min(1),
  member_sighting_ids: z.array(memberSightingRecordSchema.shape.id),
  member_sighting_revisions: z.record(
    memberSightingRecordSchema.shape.id,
    memberActivityDataSchema.shape.attribution.shape.revision,
  ),
  window_id: windowDetailSchema.shape.id.nullable(),
  window_material: windowDetailSchema
    .pick({ revision: true, inputState: true, sampledMedia: true })
    .extend({
      speech_count: z.int().nonnegative(),
      speech_enabled: windowDetailSchema.shape.speech.shape.enabled,
      pet_sound_analysis: windowDetailSchema.shape.audio.shape.petSounds
        .unwrap()
        .pick({ status: true, validity: true })
        .nullable(),
      pet_sound_count: z.int().nonnegative().nullable(),
    })
    .nullable(),
});
export const agentDevicePropertySchema =
  projectionSchema.shape.latest.valueType.omit({
    home_id: true,
    room_id: true,
    spec_id: true,
    description: true,
    type_name: true,
    service_type_name: true,
    readable: true,
    unit: true,
  });
export const agentContextDataSchemas = {
  spatial: spatialSnapshotSchema.omit({ scope: true }),
  household: projectionSchema
    .pick({ household: true, home: true, room: true, device: true })
    .extend({ specs: z.record(z.string(), specSchema) }),
  device_state: projectionSchema
    .pick({
      latest: true,
      source_health: true,
      device_coverage: true,
      collection: true,
    })
    .extend({
      latest: z.record(z.string(), agentDevicePropertySchema),
      online: z.array(
        deviceSchema.pick({ account_id: true, device_id: true, online: true }),
      ),
    }),
  members: memberListSchema,
  observations: z.object({
    range: z.object({ start: z.number(), end: z.number() }),
    records: z.array(agentObservationSchema),
    sources: z.object({
      member_sightings: agentObservationSourceSchema,
      perception: agentObservationSourceSchema,
    }),
  }),
};
function part<S extends z.ZodType>(data: S) {
  const base = z.object({ read_at: z.iso.datetime().nullable() });
  return z.discriminatedUnion("status", [
    base.extend({
      status: z.literal("loading"),
      data: z.null(),
      reason: z.null(),
      truncated: z.literal(false),
    }),
    base.extend({
      status: z.literal("ready"),
      read_at: z.iso.datetime(),
      data,
      reason: z.null(),
      truncated: z.boolean(),
    }),
    base.extend({
      status: z.literal("unavailable"),
      data: z.null(),
      reason: z.string().min(1).max(256),
      truncated: z.literal(false),
    }),
    base.extend({
      status: z.literal("failed"),
      data: z.null(),
      reason: z.string().min(1).max(256),
      truncated: z.literal(false),
    }),
  ]);
}
export const agentContextPartsSchema = z.object({
  household: part(agentContextDataSchemas.household),
  spatial: part(agentContextDataSchemas.spatial),
  device_state: part(agentContextDataSchemas.device_state),
  members: part(agentContextDataSchemas.members),
  observations: part(agentContextDataSchemas.observations),
});
export const agentContextSnapshotSchema = z.strictObject({
  scope: agentContextScopeSchema.nullable(),
  parts: agentContextPartsSchema.partial(),
});
// Reuse household change validation, including each record's stable identity.
const otherDeviceChangeSchema = changeSchema.transform((change, ctx) => {
  switch (change.entity) {
    case "latest":
      if (change.op === "remove") return { ...change, entity: change.entity };
      ctx.addIssue({
        code: "custom",
        message: "Expected a dynamic property change",
      });
      return z.NEVER;
    case "source_health":
    case "device_coverage":
    case "collection":
      return { ...change, entity: change.entity };
    default:
      ctx.addIssue({ code: "custom", message: "Invalid device state entity" });
      return z.NEVER;
  }
});
export const agentDeviceChangeSchema = z.union([
  z
    .strictObject({
      op: z.literal("upsert"),
      entity: z.literal("latest"),
      key: z.string(),
      value: agentDevicePropertySchema,
    })
    .refine(
      ({ key, value }) =>
        key ===
        propertyKey(value.account_id, value.device_id, value.siid, value.piid),
      {
        message: "Property identity mismatch",
      },
    ),
  otherDeviceChangeSchema,
]);
export const agentDeviceDeltaSchema = z.strictObject({
  status: z.literal("delta"),
  read_at: z.iso.datetime(),
  truncated: z.literal(false),
  data: z.strictObject({
    changes: z.array(agentDeviceChangeSchema),
    online: agentContextDataSchemas.device_state.shape.online.optional(),
  }),
});
export const agentContextPublicationSchema = agentContextSnapshotSchema.extend({
  parts: agentContextPartsSchema
    .extend({
      device_state: z.union([
        agentContextPartsSchema.shape.device_state,
        agentDeviceDeltaSchema,
      ]),
    })
    .partial(),
});
export const agentContextEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("snapshot"),
    data: agentContextPublicationSchema,
  }),
  z.object({ event: z.literal("heartbeat"), data: z.strictObject({}) }),
]);
const sourceSchema = z.strictObject({
  device_id: deviceHistoryQuerySchema.shape.device_ids.unwrap().element.min(1),
  channel: windowDetailSchema.shape.run.shape.channel.optional(),
});
const sources = z
  .array(sourceSchema)
  .min(1)
  .max(1024)
  .transform((items) =>
    [
      ...new Map(
        items.map((item) => [
          JSON.stringify([item.device_id, item.channel ?? null]),
          item,
        ]),
      ).values(),
    ].toSorted((a, b) =>
      a.device_id < b.device_id
        ? -1
        : a.device_id > b.device_id
          ? 1
          : (a.channel ?? 0) - (b.channel ?? 0),
    ),
  );
const history = z.strictObject({
  account_id: deviceHistoryQuerySchema.shape.account_id,
  home_id: deviceHistoryQuerySchema.shape.home_id,
  start: deviceHistoryQuerySchema.shape.start,
  end: deviceHistoryQuerySchema.shape.end,
  limit: deviceHistoryQuerySchema.shape.limit,
  cursor: deviceHistoryQuerySchema.shape.cursor,
});
export const memberSightingsHistoryQuerySchema = history
  .extend({
    kind: z.literal("member_sightings"),
    member_ids: z
      .array(memberListSchema.shape.members.element.shape.id)
      .min(1)
      .max(1000)
      .transform((items) => [...new Set(items)].toSorted())
      .optional(),
    sources: sources.optional(),
  })
  .refine((input) => input.start < input.end, {
    message: "start must precede end",
  });
export const perceptionWindowsHistoryQuerySchema = history
  .extend({
    kind: z.literal("perception_windows"),
    sources: sources.optional(),
  })
  .refine((input) => input.start < input.end, {
    message: "start must precede end",
  });
export const agentHistoryQuerySchema = z.discriminatedUnion("kind", [
  deviceHistoryQuerySchema.safeExtend({ kind: z.literal("device_reports") }),
  memberSightingsHistoryQuerySchema,
  perceptionWindowsHistoryQuerySchema,
]);
const historyResponse = history
  .omit({ limit: true, cursor: true })
  .extend({ next_cursor: z.string().nullable() });
export const memberSightingsRetention = {
  storage: "database",
  attribution: "current_revision",
  interval: "observation_span_not_continuous_presence",
  pagination: "live_without_snapshot",
} as const;
export const perceptionWindowsRetention = {
  storage: "memory",
  maximum_ms: 30 * 60_000,
  early_eviction: true,
  restart_loss: true,
  completeness: "not_guaranteed",
  pagination: "live_without_snapshot",
} as const;
export const memberSightingsHistoryResponseSchema = historyResponse.extend({
  kind: z.literal("member_sightings"),
  records: z.array(memberSightingRecordSchema),
  retention: z.object({
    storage: z.literal(memberSightingsRetention.storage),
    attribution: z.literal(memberSightingsRetention.attribution),
    interval: z.literal(memberSightingsRetention.interval),
    pagination: z.literal(memberSightingsRetention.pagination),
  }),
});
export const perceptionWindowsHistoryResponseSchema = historyResponse.extend({
  kind: z.literal("perception_windows"),
  records: z.array(perceptionWindowHistoryRecordSchema),
  retention: z.object({
    storage: z.literal(perceptionWindowsRetention.storage),
    maximum_ms: z.literal(perceptionWindowsRetention.maximum_ms),
    early_eviction: z.literal(perceptionWindowsRetention.early_eviction),
    restart_loss: z.literal(perceptionWindowsRetention.restart_loss),
    completeness: z.literal(perceptionWindowsRetention.completeness),
    pagination: z.literal(perceptionWindowsRetention.pagination),
  }),
});
export const agentHistoryResponseSchema = z.discriminatedUnion("kind", [
  deviceHistoryResponseSchema.extend({ kind: z.literal("device_reports") }),
  memberSightingsHistoryResponseSchema,
  perceptionWindowsHistoryResponseSchema,
]);

/** Resolve one reference against its authoritative source, never embed it in snapshots. */
export const agentMaterialQuerySchema = z.strictObject({
  scope: agentContextScopeSchema,
  kind: z.enum(["member_sighting", "perception_window"]),
  id: z.uuid(),
});
export const agentMaterialResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    scope: agentContextScopeSchema,
    kind: z.literal("member_sighting"),
    record: memberSightingRecordSchema,
  }),
  z.object({
    scope: agentContextScopeSchema,
    kind: z.literal("perception_window"),
    window: windowDetailSchema,
  }),
]);
