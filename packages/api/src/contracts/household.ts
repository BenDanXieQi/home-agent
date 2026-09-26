import { z } from "zod";
import { update } from "../immutable";
import {
  mijiaAccountSchema,
  mijiaDeviceSchema,
  mijiaHomeSelectionSchema,
  mijiaStateSchema,
  mijiaErrorSchema,
} from "./mijia";
import { mijiaDeviceSpecSchema } from "./mijia-spec";
import { operationSchema } from "./operations";
import { apiErrorSchema } from "./errors";

export const householdStreamPolicy = {
  snapshotBytes: 8 * 1024 * 1024,
  heartbeatMs: 15_000,
  silenceMs: 45_000,
} as const;

export const householdControlPolicy = {
  providerLength: 64,
  accountIdLength: 512,
  homeIdLength: 128,
  timestampLength: 64,
  errorBytes: 4096,
  errorMessageLength: 512,
} as const;

export const householdSpecificationPolicy = {
  errorBytes: 1024,
  errorMessageLength: 128,
} as const;

const encoder = new TextEncoder();
/** Public diagnostics must fit even when an integration reports a large error. */
function controlError<S extends z.ZodType<z.infer<typeof apiErrorSchema>>>(
  schema: S,
  limits:
    | Pick<typeof householdControlPolicy, "errorBytes" | "errorMessageLength">
    | typeof householdSpecificationPolicy = householdControlPolicy,
) {
  return schema.transform((error) => {
    if (encoder.encode(JSON.stringify(error)).byteLength <= limits.errorBytes)
      return error;
    return {
      ...error,
      message: error.message.slice(0, limits.errorMessageLength),
      params: undefined,
      issues: undefined,
      traceId: undefined,
    };
  });
}
const controlErrorSchema = controlError(mijiaErrorSchema);
const homeIdSchema = z.string().min(1).max(householdControlPolicy.homeIdLength);
const controlTimestampSchema = z.iso
  .datetime()
  .max(householdControlPolicy.timestampLength);
const accountSchema = z.discriminatedUnion("status", [
  mijiaAccountSchema.options[0],
  mijiaAccountSchema.options[1],
  mijiaAccountSchema.options[2].extend({ error: controlErrorSchema }),
]);
const connectionSchema = z.discriminatedUnion("status", [
  operationSchema.options[0].extend({
    createdAt: controlTimestampSchema,
    updatedAt: controlTimestampSchema,
  }),
  operationSchema.options[1].extend({
    createdAt: controlTimestampSchema,
    updatedAt: controlTimestampSchema,
    error: controlError(apiErrorSchema),
  }),
]);
const bindingSchema = z.discriminatedUnion("status", [
  mijiaStateSchema.shape.binding.options[0],
  mijiaStateSchema.shape.binding.options[1].extend({
    error: controlErrorSchema,
  }),
]);

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
  error: controlErrorSchema.nullable(),
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
  provider: z
    .string()
    .min(1)
    .max(householdControlPolicy.providerLength)
    .nullable(),
  account_id: z.string().max(householdControlPolicy.accountIdLength).nullable(),
  home_id: homeIdSchema.nullable(),
  status: z.enum([
    "unbound",
    "waiting_for_home",
    "initializing",
    "running",
    "stopping",
  ]),
  stage: z.enum(["account", "directory", "ready"]),
  homes: mijiaHomeSelectionSchema.omit({ items: true }).extend({
    selectedHomeId: homeIdSchema.nullable(),
  }),
  sync_status: z.enum(["unsynced", "syncing", "synced", "error"]),
  cloud_synced_at: controlTimestampSchema.nullable(),
  saved_at: controlTimestampSchema.nullable(),
  error: controlErrorSchema.nullable(),
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
const specificationIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[!-~]+$/);
const categorySchema = z.string().max(64).nullable();
export const deviceSchema = mijiaDeviceSchema.extend({
  account_id: z.string(),
  device_id: z.string(),
  spec_id: specificationIdSchema.nullable(),
  spec_status: z.enum(["loading", "ready", "error"]),
  spec_error: controlError(
    mijiaErrorSchema,
    householdSpecificationPolicy,
  ).nullable(),
  last_seen_at: z.iso.datetime(),
  archived: z.boolean(),
  alias: z.string().nullable(),
  category: categorySchema,
  capability_tags: z.array(
    z.enum(["readable", "writeable", "notify", "action", "event"]),
  ),
  availability: z.enum(["unknown", "online", "offline"]),
  read_enabled_properties: z.array(
    z.object({ siid: z.number().int(), piid: z.number().int() }),
  ),
});
export const initialSpecification = Object.freeze({
  spec_id: null,
  spec_status: "loading",
  spec_error: null,
} satisfies Pick<
  z.infer<typeof deviceSchema>,
  "spec_id" | "spec_status" | "spec_error"
>);
export const specSchema = z.object({
  id: specificationIdSchema,
  urn: specificationIdSchema,
  version: z.string().max(64),
  category: categorySchema,
  spec: mijiaDeviceSpecSchema.shape.spec,
});
export const directorySchema = z.object({
  home: z.record(z.string(), homeSchema),
  room: z.record(z.string(), roomSchema),
  device: z.record(z.string(), deviceSchema),
});
export const projectionSchema = z.object({
  account: z.object({ account: accountSchema }),
  login: z.object({ login: loginPublicSchema }),
  connection: z.object({ connection: connectionSchema.nullable() }),
  media: z.object({
    media: z.object({
      revision: z.uuid(),
      binding: bindingSchema,
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
});
export type Projection = z.infer<typeof projectionSchema>;
export const entityKey = (...parts: string[]) => JSON.stringify(parts);
const matchesIdentity = {
  home: (key: string, value: z.infer<typeof homeSchema>) =>
    key === entityKey(value.account_id, value.home_id),
  room: (key: string, value: z.infer<typeof roomSchema>) =>
    key === entityKey(value.account_id, value.home_id, value.room_id),
  device: (key: string, value: z.infer<typeof deviceSchema>) =>
    key === entityKey(value.account_id, value.device_id) &&
    value.id === value.device_id,
};
function change<E extends string, S extends z.ZodType>(entity: E, schema: S) {
  return z.object({
    op: z.literal("upsert"),
    entity: z.literal(entity),
    key: z.string(),
    value: schema,
  });
}
export const upsertChangeSchema = z
  .discriminatedUnion("entity", [
    change("account", accountSchema),
    change("login", loginPublicSchema),
    change("connection", connectionSchema.nullable()),
    change("media", projectionSchema.shape.media.shape.media),
    change("household", householdSchema),
    change(
      "projection_health",
      projectionSchema.shape.projection_health.shape.projection_health,
    ),
    change("home", homeSchema),
    change("room", roomSchema),
    change("device", deviceSchema),
  ])
  .refine((item) => {
    switch (item.entity) {
      case "home":
        return matchesIdentity.home(item.key, item.value);
      case "room":
        return matchesIdentity.room(item.key, item.value);
      case "device":
        return matchesIdentity.device(item.key, item.value);
      default:
        return item.key === item.entity;
    }
  });
export const changeSchema = z.discriminatedUnion("op", [
  upsertChangeSchema,
  z.object({
    op: z.literal("remove"),
    entity: z.enum(["home", "room", "device"]),
    key: z.string(),
  }),
]);
export const snapshotSchema = stateVersionSchema
  .extend({ projection: projectionSchema })
  .superRefine(({ projection }, ctx) => {
    function checkIdentities<T>(
      entity: keyof typeof matchesIdentity,
      records: Record<string, T>,
      matches: (key: string, value: T) => boolean,
    ) {
      for (const [key, value] of Object.entries(records)) {
        if (!matches(key, value))
          ctx.addIssue({
            code: "custom",
            message: "Entity identity mismatch",
            path: ["projection", entity, key],
          });
      }
    }
    checkIdentities("home", projection.home, matchesIdentity.home);
    checkIdentities("room", projection.room, matchesIdentity.room);
    checkIdentities("device", projection.device, matchesIdentity.device);
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
export const setupHomesSchema = mijiaHomeSelectionSchema.pick({ items: true });
export const selectHomeSchema = z.strictObject({
  scope_epoch: z.uuid(),
  home_id: homeIdSchema,
});
export const refreshDirectorySchema = z.strictObject({
  scope_epoch: z.uuid(),
  target: z.enum(["directory", "specs", "all"]),
});
export type DirectoryRefreshTarget = z.infer<
  typeof refreshDirectorySchema
>["target"];

/** Apply a batch validated by stateChangeSchema at the input boundary. */
export function applyChanges(
  projection: Projection,
  input: z.infer<typeof stateChangeSchema>,
) {
  const { changes } = input;
  if (!changes.length) return projection;
  return update(projection, (draft) => {
    const copied = new Map<keyof Projection, Record<string, unknown>>();
    for (const item of changes) {
      let records = copied.get(item.entity);
      if (!records) {
        records = { ...projection[item.entity] };
        copied.set(item.entity, records);
        Object.assign(draft, { [item.entity]: records });
      }
      if (item.op === "remove") delete records[item.key];
      else
        Object.defineProperty(records, item.key, {
          value: item.value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
  });
}
