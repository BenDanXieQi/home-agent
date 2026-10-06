import { z } from "zod";
import {
  deviceHistoryQuerySchema,
  deviceHistoryResponseSchema,
} from "./device-history";

export const agentHistoryQuerySchema = deviceHistoryQuerySchema.extend({
  kind: z.literal("device_reports"),
});
export const agentHistoryResponseSchema = z.discriminatedUnion(
  "representation",
  [
    deviceHistoryResponseSchema.options[0].extend({
      kind: z.literal("device_reports"),
    }),
    deviceHistoryResponseSchema.options[1].extend({
      kind: z.literal("device_reports"),
    }),
  ],
);
