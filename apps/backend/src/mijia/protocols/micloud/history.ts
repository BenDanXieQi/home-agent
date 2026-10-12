import { z } from "zod";
const device = z.string().min(1).max(512);
const seconds = z.number().int().safe().nonnegative();
export const deviceDataRequestSchema = z
  .object({
    did: device,
    key: z.string().min(1),
    type: z.enum(["prop", "event"]),
    time_start: seconds,
    time_end: seconds,
    limit: z.number().int().min(1).max(1000),
  })
  .refine((input) => input.time_start < input.time_end);
export const deviceDataRawRequestSchema = z
  .object({
    did: device,
    key: z.string().min(1),
    type: z.enum(["prop", "store"]),
    time_start: seconds,
    time_end: seconds,
    limit: z.number().int().min(1).max(500),
  })
  .refine((input) => input.time_start < input.time_end);
export const userDeviceLogRequestSchema = z
  .object({
    did: device,
    time_start: seconds,
    time_end: seconds,
    limit: z.number().int().min(1).max(50),
  })
  .refine((input) => input.time_start < input.time_end);
const providerId = z
  .union([z.string().min(1), z.number().int().safe()])
  .transform(String);
export const deviceDataRowSchema = z.looseObject({
  uid: providerId,
  did: providerId,
  type: z.string(),
  key: z.string(),
  time: seconds,
  value: z.string(),
});
export const userDeviceLogRowSchema = z.looseObject({
  type: z.string(),
  key: z.string(),
  timestamp: seconds,
  value: z.string(),
});
export const sceneHistoryResponseSchema = z.object({
  history: z.array(
    z.looseObject({
      homeId: providerId,
      userSceneId: providerId,
      from: z.unknown(),
      name: z.string(),
      time: seconds,
      msg: z.array(z.unknown()),
    }),
  ),
});
