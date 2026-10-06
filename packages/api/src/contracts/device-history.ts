import { z } from "zod";
import { deviceCapabilitySchema } from "../domain/devices";
import { propertyAddressSchema, propertyValueSchema } from "./observations";
import { apiErrorSchema } from "./errors";
import { householdInventoryPolicy } from "./household";

export const deviceHistoryPolicy = {
  retentionDays: 365,
  defaultLimit: 100,
  maxLimit: 1000,
  responseBytes: 1024 * 1024,
  requestBytes: 128 * 1024,
  exportBytes: 64 * 1024 * 1024,
} as const;
export const deviceHistoryKindSchema = z.enum(["property", "online"]);
export const deviceHistoryPropertySchema = z.strictObject({
  device_id: propertyAddressSchema.shape.did,
  siid: propertyAddressSchema.shape.siid,
  piid: propertyAddressSchema.shape.piid,
});
export const deviceHistoryMetadataSchema = z.object({
  property_name: deviceCapabilitySchema.shape.description.nullable(),
  unit: deviceCapabilitySchema.shape.unit.unwrap().nullable(),
  value_list: deviceCapabilitySchema.shape.value_list.unwrap().nullable(),
});
const property = deviceHistoryPropertySchema.extend({
  kind: z.literal("property"),
  value: propertyValueSchema,
  source: z.enum(["push", "retained", "read"]),
  metadata: deviceHistoryMetadataSchema,
});
const online = z.object({
  kind: z.literal("online"),
  device_id: propertyAddressSchema.shape.did,
  value: z.boolean(),
  source: z.enum(["push", "retained", "directory"]),
});
const report = z.object({
  observation_id: z.uuid(),
  received_at: z.iso.datetime(),
  scope_epoch: z.uuid(),
  input_sequence: z.number().int().nonnegative(),
});
export const deviceHistoryReportSchema = z.discriminatedUnion("kind", [
  property.extend(report.shape),
  online.extend(report.shape),
]);
export const deviceHistoryTimeSchema = z.iso
  .datetime()
  .refine((value) => !value.startsWith("0000-"), {
    message: "Use a PostgreSQL-compatible year",
  })
  .refine((value) => (value.match(/\.(\d+)Z$/)?.[1]?.length ?? 0) <= 6, {
    message: "Use at most microsecond precision",
  })
  .transform(
    (value) =>
      `${new Date(value).toISOString().slice(0, 19)}.${(value.match(/\.(\d+)Z$/)?.[1] ?? "").padEnd(6, "0")}Z`,
  );
export const deviceHistoryQuerySchema = z
  .strictObject({
    account_id: z.string().min(1).max(512),
    home_id: z.string().min(1).max(128),
    properties: z
      .array(deviceHistoryPropertySchema)
      .min(1)
      .max(1000)
      .optional(),
    device_ids: z
      .array(propertyAddressSchema.shape.did)
      .min(1)
      .max(householdInventoryPolicy.devices)
      .optional(),
    kinds: z
      .array(deviceHistoryKindSchema)
      .min(1)
      .max(2)
      .default(["property", "online"]),
    start: deviceHistoryTimeSchema,
    end: deviceHistoryTimeSchema,
    order: z.enum(["asc", "desc"]).default("asc"),
    limit: z
      .number()
      .int()
      .positive()
      .max(deviceHistoryPolicy.maxLimit)
      .default(deviceHistoryPolicy.defaultLimit),
    cursor: z
      .string()
      .min(1)
      .max(128 * 1024)
      .optional(),
  })
  .refine((input) => input.start < input.end, {
    message: "start must precede end",
  });
const storedProperty = property.extend({ definition_id: z.uuid() });
const observation = z.object({
  observation_id: z.uuid(),
  received_at: z.iso.datetime(),
});
export const deviceHistoryObservationSchema = z.discriminatedUnion("kind", [
  storedProperty.extend(observation.shape),
  online.extend(observation.shape),
]);
const response = z.object({
  account_id: deviceHistoryQuerySchema.shape.account_id,
  home_id: deviceHistoryQuerySchema.shape.home_id,
  start: deviceHistoryQuerySchema.shape.start,
  end: deviceHistoryQuerySchema.shape.end,
  retention_days: z.literal(deviceHistoryPolicy.retentionDays),
  next_cursor: z.string().nullable(),
});
export const deviceHistoryResponseSchema = response.extend({
  records: z.array(deviceHistoryObservationSchema),
});

export function deviceHistoryRecordId(
  record: z.infer<typeof deviceHistoryResponseSchema>["records"][number],
) {
  return record.observation_id;
}

export const deviceHistoryStreamPolicy = {
  connections: 16,
  heartbeatMs: 15_000,
  writeTimeoutMs: 15_000,
  coalesceMs: 250,
  eventBytes: deviceHistoryPolicy.responseBytes + 128 * 1024,
  queuedBytes: 2 * (deviceHistoryPolicy.responseBytes + 128 * 1024),
  queuedEvents: 256,
} as const;

export const deviceHistoryStreamRequestSchema = deviceHistoryQuerySchema
  .safeExtend({ delivery: z.enum(["live", "page", "export"]).default("page") })
  .refine(
    (input) =>
      input.delivery !== "live" || (!input.cursor && input.order === "desc"),
    {
      message: "Live delivery requires descending order and no page cursor",
    },
  );

const changedPage = {
  record_ids: z.array(z.uuid()).max(deviceHistoryPolicy.maxLimit),
  removed_ids: z.array(z.uuid()).max(deviceHistoryPolicy.maxLimit),
};
export const deviceHistoryChangeSchema = deviceHistoryResponseSchema
  .extend(changedPage)
  .refine(
    (page) => {
      const ids = new Set(page.record_ids);
      const upserts = new Set(page.records.map(deviceHistoryRecordId));
      const removed = new Set(page.removed_ids);
      return (
        ids.size === page.record_ids.length &&
        upserts.size === page.records.length &&
        removed.size === page.removed_ids.length &&
        [...upserts].every((id) => ids.has(id)) &&
        [...removed].every((id) => !ids.has(id))
      );
    },
    {
      message:
        "History changes require unique page identities and consistent upserts/removals",
    },
  );

export const deviceHistoryStreamEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("page"), data: deviceHistoryResponseSchema }),
  z.object({ event: z.literal("change"), data: deviceHistoryChangeSchema }),
  z.object({ event: z.literal("heartbeat"), data: z.strictObject({}) }),
  z.object({ event: z.literal("complete"), data: z.strictObject({}) }),
  z.object({ event: z.literal("error"), data: apiErrorSchema }),
]);
