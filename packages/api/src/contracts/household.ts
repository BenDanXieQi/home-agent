import { z } from "zod";
import {
  mijiaAccountSchema,
  mijiaDeviceSchema,
  mijiaHomeSelectionSchema,
  mijiaStateSchema,
  mijiaErrorSchema,
} from "./mijia";
import { mijiaDeviceSpecSchema } from "./mijia-spec";
import { operationSchema } from "./operations";

export const householdStreamPolicy = {
  snapshotBytes: 8 * 1024 * 1024,
  heartbeatMs: 15_000,
  silenceMs: 45_000,
} as const;

export const stateVersionSchema = z.object({
  scope_epoch: z.uuid(),
  sequence: z.number().int().nonnegative(),
});
export const loginPublicSchema = z.object({
  id: z.uuid().nullable(),
  status: z.enum([
    "idle",
    "creating",
    "pending",
    "security_required",
    "completing",
    "completed",
    "expired",
    "error",
    "cancelled",
  ]),
  error: mijiaErrorSchema.nullable(),
  material_version: z.number().int().nonnegative(),
});
export const loginMaterialSchema = z.object({
  id: z.uuid(),
  material_version: z.number().int().nonnegative(),
  qr_image_url: z.string().nullable(),
  verification_url: z.url().nullable(),
  expires_at: z.iso.datetime().nullable(),
});
export const householdSchema = z.object({
  account_id: z.string().nullable(),
  home_id: z.string().nullable(),
  status: z.enum([
    "unbound",
    "waiting_for_home",
    "initializing",
    "running",
    "stopping",
  ]),
  stage: z.enum(["account", "selection", "directory", "ready"]),
  homes: mijiaHomeSelectionSchema,
  sync_status: z.enum(["unsynced", "syncing", "synced", "error"]),
  cloud_synced_at: z.iso.datetime().nullable(),
  saved_at: z.iso.datetime().nullable(),
  error: mijiaErrorSchema.nullable(),
});
export const homeSchema = z.object({
  account_id: z.string(),
  home_id: z.string(),
  name: z.string(),
  shared: z.boolean(),
  last_seen_at: z.iso.datetime(),
  archived: z.boolean(),
});
export const roomSchema = z.object({
  account_id: z.string(),
  home_id: z.string(),
  room_id: z.string(),
  name: z.string(),
  last_seen_at: z.iso.datetime(),
  archived: z.boolean(),
});
export const deviceSchema = mijiaDeviceSchema.extend({
  account_id: z.string(),
  device_id: z.string(),
  spec_id: z.string().nullable(),
  last_seen_at: z.iso.datetime(),
  archived: z.boolean(),
  alias: z.string().nullable(),
  category: z.string().nullable(),
  capability_tags: z.array(
    z.enum(["readable", "writeable", "notify", "action", "event"]),
  ),
  availability: z.enum(["unknown", "online", "offline"]),
  read_enabled_properties: z.array(
    z.object({ siid: z.number().int(), piid: z.number().int() }),
  ),
});
export const specSchema = z.object({
  id: z.string(),
  urn: z.string(),
  version: z.string(),
  status: z.enum(["loading", "ready", "error"]),
  category: mijiaDeviceSpecSchema.shape.category,
  spec: mijiaDeviceSpecSchema.shape.spec,
  error: mijiaErrorSchema.nullable(),
});
export const directorySchema = z.object({
  home: z.record(z.string(), homeSchema),
  room: z.record(z.string(), roomSchema),
  device: z.record(z.string(), deviceSchema),
});
const emptyDomain = z.record(z.string(), z.never());
export const projectionSchema = z.object({
  account: z.object({ account: mijiaAccountSchema }),
  login: z.object({ login: loginPublicSchema }),
  connection: z.object({ connection: operationSchema.nullable() }),
  media: z.object({
    media: z.object({
      revision: z.uuid(),
      binding: mijiaStateSchema.shape.binding,
    }),
  }),
  household: z.object({ household: householdSchema }),
  projection_health: z.object({
    projection_health: z.object({
      storage_degraded: z.boolean(),
      capacity_degraded: z.boolean(),
    }),
  }),
  ...directorySchema.shape,
  spec: z.record(z.string(), specSchema),
  latest: emptyDomain,
  source_health: emptyDomain,
  rule_status: emptyDomain,
});
export type Projection = z.infer<typeof projectionSchema>;
export const entityKey = (...parts: string[]) => JSON.stringify(parts);
function change<E extends string, S extends z.ZodType>(entity: E, schema: S) {
  return z.object({
    op: z.literal("upsert"),
    entity: z.literal(entity),
    key: z.string(),
    value: schema,
  });
}
export const changeSchema = z
  .discriminatedUnion("op", [
    z.discriminatedUnion("entity", [
      change("account", mijiaAccountSchema),
      change("login", loginPublicSchema),
      change("connection", operationSchema.nullable()),
      change("media", projectionSchema.shape.media.shape.media),
      change("household", householdSchema),
      change(
        "projection_health",
        projectionSchema.shape.projection_health.shape.projection_health,
      ),
      change("home", homeSchema),
      change("room", roomSchema),
      change("device", deviceSchema),
      change("spec", specSchema),
    ]),
    z.object({
      op: z.literal("remove"),
      entity: z.enum(["home", "room", "device", "spec"]),
      key: z.string(),
    }),
  ])
  .refine((item) => {
    if (item.op === "remove") return true;
    switch (item.entity) {
      case "home":
        return (
          item.key === entityKey(item.value.account_id, item.value.home_id)
        );
      case "room":
        return (
          item.key ===
          entityKey(
            item.value.account_id,
            item.value.home_id,
            item.value.room_id,
          )
        );
      case "device":
        return (
          item.key === entityKey(item.value.account_id, item.value.device_id) &&
          item.value.id === item.value.device_id
        );
      case "spec":
        return item.key === item.value.id;
      default:
        return item.key === item.entity;
    }
  });
export const snapshotSchema = stateVersionSchema
  .extend({ projection: projectionSchema })
  .superRefine(({ projection }, ctx) => {
    for (const entity of ["home", "room", "device", "spec"] as const)
      for (const [key, value] of Object.entries(projection[entity])) {
        if (
          !changeSchema.safeParse({ op: "upsert", entity, key, value }).success
        )
          ctx.addIssue({
            code: "custom",
            message: "Entity identity mismatch",
            path: ["projection", entity, key],
          });
      }
  });
export const stateChangeSchema = stateVersionSchema.extend({
  changes: z.array(changeSchema),
});
export const resyncSchema = stateVersionSchema.extend({
  reason: z.enum([
    "scope_changed",
    "slow_client",
    "stopping",
    "capacity_degraded",
  ]),
  retry_after_ms: z.number().nonnegative().optional(),
});
export const commandResultSchema = z.object({
  state_version: stateVersionSchema,
});
export const selectHomeSchema = z.strictObject({
  scope_epoch: z.uuid(),
  home_id: z.string().min(1).max(128).nullable(),
});
export const refreshDirectorySchema = z.strictObject({
  scope_epoch: z.uuid(),
  target: z.enum(["directory", "specs", "all"]),
});
export type DirectoryRefreshTarget = z.infer<
  typeof refreshDirectorySchema
>["target"];

/** Validate the whole batch before exposing any mutation. */
export function applyChanges(
  projection: Projection,
  input: z.infer<typeof stateChangeSchema>,
) {
  const next = structuredClone(projection);
  for (const item of stateChangeSchema.parse(input).changes) {
    const records: Record<string, unknown> = next[item.entity];
    if (item.op === "remove") delete records[item.key];
    else records[item.key] = item.value;
  }
  return projectionSchema.parse(next);
}
