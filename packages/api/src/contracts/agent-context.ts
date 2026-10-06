import { z } from "zod";
import {
  deviceHistoryQuerySchema,
  deviceHistoryResponseSchema,
} from "./device-history";

export const agentHistoryQuerySchema = deviceHistoryQuerySchema.extend({
  kind: z.literal("device_reports"),
});
export const agentHistoryResponseSchema = deviceHistoryResponseSchema.extend({
  kind: z.literal("device_reports"),
});
