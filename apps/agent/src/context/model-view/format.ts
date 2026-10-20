import { z } from "zod";
import { propertyValueSchema } from "@home-agent/api/observations";
import { memberListSchema } from "@home-agent/api/household-members";
import {
  agentContextDataSchemas,
  agentContextPartsSchema,
  agentObservationReasonSchema,
} from "@home-agent/api/agent-context";

const sourceStatus =
  agentContextDataSchemas.observations.shape.sources.shape.member_sightings
    .shape.status;
export const latestObservationsSchema = z.object({
  as_of: z.iso.datetime(),
  sources: z.object({
    member_sightings: sourceStatus,
    perception: sourceStatus,
  }),
  members: z.array(
    memberListSchema.shape.members.element.extend({
      last_seen: z.array(
        z.object({
          at: z.iso.datetime(),
          location: z.string(),
          identity: z.enum(["已确认", "待确认", "推断"]),
        }),
      ),
    }),
  ),
  clues: z.array(
    z.object({
      device_id: z.string(),
      name: z.string(),
      channel: z.number(),
      latest: z.array(
        z.object({ kind: agentObservationReasonSchema, at: z.iso.datetime() }),
      ),
    }),
  ),
});

export const operationsSchema = agentContextPartsSchema.shape.operations;

export const reference = z.int().nonnegative();
export const timeCell = z.string();
export const valueRow = z.tuple([
  z.string(),
  propertyValueSchema,
  z.string().nullable().optional(),
  z.string().nullable().optional(),
  timeCell.nullable().optional(),
]);
export const reportGroup = z.tuple([
  z.string(),
  z.array(valueRow),
  timeCell.nullable().optional(),
  timeCell.nullable().optional(),
  timeCell.nullable().optional(),
]);
export const deviceStateSchema = z.object({
  device_id: z.string(),
  name: z.string(),
  online: z.boolean(),
  reports: z.array(reportGroup),
});
export const deviceRow = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.string().nullable(),
  reference,
]);
export const capabilityGroup = z.tuple([
  z.int().refine((v) => (v >= 1 && v <= 8) || v === 16),
  z.string(),
  z.array(z.tuple([reference, z.string(), z.string()])),
]);
export const metaSchema = z.object({
  家庭: z.array(z.object({ 名称: z.string(), id: z.string() })),
  空间关系: agentContextDataSchemas.spatial,
});

export const format = {
  D: ["device_id", "name", "room", "category", "S_index"],
  C: ["access", "datatype_or_kind", "definitions"],
  C_definition: ["C_index", "query_key", "name"],
  report_group: [
    "reason",
    "V_rows",
    "received_at",
    "observed_at",
    "expires_at",
  ],
  V: ["query_key", "raw_value", "unit", "enum_label", "last_change_at"],
  access: {
    "1": "read",
    "2": "write",
    "4": "notify",
    "8": "action",
    "16": "event",
  },
};
