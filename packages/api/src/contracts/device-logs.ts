import { z } from "zod";

const count = z.number().int().nonnegative();
export const deviceLogEntrySchema = z.object({
  sequence: count,
  received_at: z.iso.datetime(),
  kind: z.enum(["property", "online", "connection", "subscription"]),
  device_id: z.string().nullable(),
  device_name: z.string(),
  room_name: z.string(),
  property: z.string(),
  description: z.string(),
  value: z.string(),
  previous_value: z.string().nullable(),
  change: z.enum(["first", "changed", "same", "control"]),
  observation: z.record(z.string(), z.unknown()),
});
export const deviceLogRunSchema = z.object({
  id: z.uuid(),
  account_id: z.string(),
  home_id: z.string(),
  home_name: z.string(),
  scope_epoch: z.string(),
  status: z.enum(["capturing", "complete", "stopped", "interrupted", "error"]),
  reason: z.string().nullable(),
  started_at: z.iso.datetime(),
  finished_at: z.iso.datetime().nullable(),
  duration_seconds: count,
  elapsed_seconds: z.number().nonnegative(),
  device_count: count,
  excluded_devices: z.array(z.object({ id: z.string(), name: z.string() })),
  expected_topics: count,
  confirmed_topics: count,
  failed_topics: count,
  all_confirmed_at: z.iso.datetime().nullable(),
  connection: z.enum(["unknown", "connecting", "connected", "closed"]),
  disconnections: count,
  packets: count,
  payload_bytes: count,
  property_reports: count,
  online_reports: count,
  first_reports: count,
  value_changes: count,
  same_value_reports: count,
  retained_reports: count,
  total_rows: count,
  minutes: z.array(
    z.object({
      offset: count,
      packets: count,
      properties: count,
      online: count,
    }),
  ),
  devices: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      room: z.string(),
      packets: count,
      properties: count,
      online: count,
    }),
  ),
});
export const deviceLogSnapshotSchema = z.object({
  run: deviceLogRunSchema.nullable(),
  entries: z.array(deviceLogEntrySchema),
});
export const startDeviceLogSchema = z.object({
  duration_seconds: z.number().int().min(60).max(3600).default(600),
});

export type DeviceLogEntry = z.infer<typeof deviceLogEntrySchema>;
export type DeviceLogSnapshot = z.infer<typeof deviceLogSnapshotSchema>;
