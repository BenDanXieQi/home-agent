import { z } from "zod";
import { deviceSchema, roomSchema, stateVersionSchema } from "./household";
import {
  latestPropertySchema,
  deviceCoverageSchema,
  collectionStatusSchema,
} from "./observations";
import { memberListSchema } from "./household-members";

export const householdQueryLimits = {
  responseBytes: 128 * 1024,
  timeoutMs: 10_000,
} as const;
export const householdQueryScopeSchema = z.strictObject({
  scope_epoch: z.uuid(),
});
const pagination = {
  offset: z.number().int().min(0).max(20_000).default(0),
  limit: z.number().int().min(1).max(50).default(20),
};
export const householdOverviewInputSchema = z.strictObject(pagination);
export const devicesQueryInputSchema = z.strictObject({
  ...pagination,
  query: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("名称、别名、型号或类别的部分文字"),
  room_id: z
    .string()
    .min(1)
    .max(128)
    .nullable()
    .optional()
    .describe("房间 ID；null 仅查未分配房间，省略查询所有房间"),
  category: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("设备类别代码，精确匹配；可从家庭概览获取"),
});
export const deviceStateInputSchema = z.strictObject({
  ...pagination,
  device_id: z.string().min(1).max(512).describe("query_devices 返回的设备 ID"),
});
export const membersQueryInputSchema = z.strictObject({
  ...pagination,
  query: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("姓名、宠物名、物种或资料描述中的部分文字"),
  kind: memberListSchema.shape.members.element.shape.kind.optional(),
});
export const householdOverviewRequestSchema =
  householdOverviewInputSchema.extend(householdQueryScopeSchema.shape);
export const devicesQueryRequestSchema = devicesQueryInputSchema.extend(
  householdQueryScopeSchema.shape,
);
export const deviceStateRequestSchema = deviceStateInputSchema.extend(
  householdQueryScopeSchema.shape,
);
export const membersQueryRequestSchema = membersQueryInputSchema.extend(
  householdQueryScopeSchema.shape,
);
export const householdQueryResultSchema = z.object({
  state_version: stateVersionSchema,
  queried_at: z.iso.datetime(),
});
const page = {
  total: z.number().int().nonnegative(),
  next_offset: z.number().int().nonnegative().nullable(),
};
export const deviceSummarySchema = deviceSchema.pick({
  device_id: true,
  name: true,
  alias: true,
  model: true,
  room_id: true,
  room_name: true,
  category: true,
  online: true,
  spec_status: true,
});
export const householdOverviewResponseSchema =
  householdQueryResultSchema.extend({
    home_name: z.string(),
    rooms: z.array(
      roomSchema
        .pick({ room_id: true, name: true })
        .extend({ device_count: z.number().int().nonnegative() }),
    ),
    ...page,
    device_count: z.number().int().nonnegative(),
    unassigned_device_count: z.number().int().nonnegative(),
    categories: z.array(
      z.object({
        category: z.string().nullable(),
        count: z.number().int().nonnegative(),
      }),
    ),
    members: z.object({
      people: z.number().int().nonnegative(),
      pets: z.number().int().nonnegative(),
    }),
  });
export const devicesQueryResponseSchema = householdQueryResultSchema.extend({
  devices: z.array(deviceSummarySchema),
  ...page,
});
export const deviceStateResponseSchema = householdQueryResultSchema.extend({
  device: deviceSummarySchema,
  properties: z.array(
    latestPropertySchema
      .omit({ account_id: true, home_id: true, read_candidate: true })
      .extend({ value_label: z.string().nullable() }),
  ),
  coverage: deviceCoverageSchema.nullable(),
  collection: collectionStatusSchema,
  ...page,
});
export const membersQueryResponseSchema = householdQueryResultSchema.extend({
  ...memberListSchema.shape,
  ...page,
});
