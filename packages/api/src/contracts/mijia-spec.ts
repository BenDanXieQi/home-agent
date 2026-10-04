import { deviceCapabilitySchema } from "../domain/devices";
import { z } from "zod";

export const mijiaDeviceSpecSchema = z.object({
  did: z.string(),
  name: z.string(),
  home: z.string(),
  model: z.string(),
  room: z.string(),
  online: z.boolean(),
  category: z.string().nullable(),
  spec: z.record(z.string(), deviceCapabilitySchema),
});
export type MijiaDeviceSpec = z.infer<typeof mijiaDeviceSpecSchema>;
