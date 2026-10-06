import { z } from "zod";
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
} from "./household";
import { memberListSchema } from "./household-members";
import {
  contextEntityTypeSchema,
  contextEntityRoleSchema,
} from "./household-context";
import {
  memberActivityDataSchema,
  perceptionSnapshotSchema,
} from "./perception";
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
    household: 8 * 1024 * 1024,
    device_state: 2 * 1024 * 1024,
    members: 1024 * 1024,
    member_sightings: 2 * 1024 * 1024,
    perception: 2 * 1024 * 1024,
  },
  recentSightings: 200,
  recentWindows: 100,
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
export const agentContextDataSchemas = {
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
      online: z.array(
        deviceSchema.pick({ account_id: true, device_id: true, online: true }),
      ),
    }),
  members: memberListSchema,
  member_sightings: z.object({ records: z.array(memberSightingRecordSchema) }),
  perception: z.object({
    snapshot: perceptionSnapshotSchema,
    windows: z.array(windowDetailSchema),
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
  device_state: part(agentContextDataSchemas.device_state),
  members: part(agentContextDataSchemas.members),
  member_sightings: part(agentContextDataSchemas.member_sightings),
  perception: part(agentContextDataSchemas.perception),
});
export const agentContextSnapshotSchema = z.strictObject({
  scope: agentContextScopeSchema.nullable(),
  parts: agentContextPartsSchema.partial(),
});
export const agentContextEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("snapshot"), data: agentContextSnapshotSchema }),
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
