import { z } from "zod";

export const miotPropertyAddressSchema = z.object({
  did: z.string().min(1),
  siid: z.number().int().positive(),
  piid: z.number().int().positive(),
});
export type MiotPropertyAddress = z.infer<typeof miotPropertyAddressSchema>;

/** Application budgets for one cloud property request, not upstream guarantees. */
export const MIOT_PROPERTY_BATCH_SIZE = 150;
export const MIOT_PROPERTY_TIMEOUT_MS = 30_000;
