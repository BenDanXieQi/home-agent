import { z } from "zod";
import {
  deviceValueSchema,
  inventoryDeviceSchema,
} from "@home-agent/api/devices";
import type {
  deviceControlResultSchema,
  commandTargetSchema,
} from "@home-agent/api/action-provenance";

const deviceId = inventoryDeviceSchema.shape.id.min(1).max(512);
const capabilityKey = z.string().min(1);
export const deviceOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("property"),
    device_id: deviceId,
    property_key: capabilityKey,
    value: deviceValueSchema,
  }),
  z.strictObject({
    kind: z.literal("action"),
    device_id: deviceId,
    action_key: capabilityKey,
    inputs: z.array(deviceValueSchema),
  }),
]);

export type DeviceControl = {
  prepare: (command: z.infer<typeof deviceOperationSchema>) => {
    target: ReturnType<typeof commandTargetSchema.parse>;
    dispatch: (
      signal: AbortSignal,
      assertCurrent: () => void,
      onSendStarted: (at: string) => void,
    ) => Promise<ReturnType<typeof deviceControlResultSchema.parse>>;
  };
};
