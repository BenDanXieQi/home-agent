import { z } from "zod";

export const mijiaCapabilitySchema = z.object({
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
export const mijiaDeviceSpecSchema = z.object({
  did: z.string(),
  name: z.string(),
  home: z.string(),
  model: z.string(),
  room: z.string(),
  online: z.boolean(),
  category: z.string().nullable(),
  spec: z.record(z.string(), mijiaCapabilitySchema),
});
export type MijiaCapability = z.infer<typeof mijiaCapabilitySchema>;
export type MijiaDeviceSpec = z.infer<typeof mijiaDeviceSpecSchema>;
