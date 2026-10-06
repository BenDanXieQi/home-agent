import { z } from "zod";
import { deviceCapabilitySchema } from "../domain/devices";
import { propertyAddressSchema, propertyValueSchema } from "./observations";

export const deviceHistoryPolicy = {
  retentionDays: 365,
  defaultLimit: 100,
  maxLimit: 1000,
  responseBytes: 1024 * 1024,
  requestBytes: 128 * 1024,
} as const;
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
export const deviceHistoryReportSchema = deviceHistoryPropertySchema.extend({
  observation_id: z.uuid(),
  received_at: z.iso.datetime(),
  scope_epoch: z.uuid(),
  input_sequence: z.number().int().nonnegative(),
  value: propertyValueSchema,
  source: z.enum(["push", "retained", "read"]),
  metadata: deviceHistoryMetadataSchema,
});
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
    start: deviceHistoryTimeSchema,
    end: deviceHistoryTimeSchema,
    representation: z.enum(["runs", "observations"]).default("runs"),
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
const common = deviceHistoryPropertySchema.extend({
  definition_id: z.uuid(),
  value: propertyValueSchema,
  source: deviceHistoryReportSchema.shape.source,
  metadata: deviceHistoryMetadataSchema,
});
export const deviceHistoryObservationSchema = common.extend({
  observation_id: z.uuid(),
  received_at: z.iso.datetime(),
});
export const deviceHistoryRunSchema = common.extend({
  first_received_at: z.iso.datetime(),
  last_received_at: z.iso.datetime(),
  first_observation_id: z.uuid(),
  last_observation_id: z.uuid(),
  report_count: z.number().int().positive(),
});
const response = z.object({
  account_id: deviceHistoryQuerySchema.shape.account_id,
  home_id: deviceHistoryQuerySchema.shape.home_id,
  start: deviceHistoryQuerySchema.shape.start,
  end: deviceHistoryQuerySchema.shape.end,
  retention_days: z.literal(deviceHistoryPolicy.retentionDays),
  next_cursor: z.string().nullable(),
});
export const deviceHistoryResponseSchema = z.discriminatedUnion(
  "representation",
  [
    response.extend({
      representation: z.literal("observations"),
      records: z.array(deviceHistoryObservationSchema),
    }),
    response.extend({
      representation: z.literal("runs"),
      records: z.array(deviceHistoryRunSchema),
    }),
  ],
);
