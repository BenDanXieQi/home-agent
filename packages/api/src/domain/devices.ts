import { z } from "zod";

export const inventoryDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  model: z.string(),
  home_id: z.string().nullable(),
  home_name: z.string().nullable(),
  room_id: z.string().nullable(),
  room_name: z.string().nullable(),
  online: z.boolean(),
  camera: z.boolean(),
  channels: z.array(z.union([z.literal(1), z.literal(2)])),
});
export const deviceCapabilitySchema = z.object({
  description: z.string(),
  format: z.string(),
  writeable: z.boolean(),
  readable: z.boolean(),
  notify: z.boolean(),
  unit: z.string().optional(),
  value_range: z.tuple([z.number(), z.number(), z.number()]).optional(),
  value_list: z
    .array(
      z.object({
        value: z.union([z.string(), z.number(), z.boolean()]),
        name: z.string(),
        description: z.string(),
      }),
    )
    .optional(),
  type_name: z.string().optional(),
  service_type_name: z.string().optional(),
  service_description: z.string().optional(),
  in_params: z
    .array(z.object({ name: z.string(), format: z.string() }))
    .optional(),
  prop_description: z.string().optional(),
});

export function deviceRoomKey(
  device: Pick<z.infer<typeof inventoryDeviceSchema>, "home_id" | "room_id">,
) {
  return JSON.stringify([device.home_id, device.room_id]);
}
