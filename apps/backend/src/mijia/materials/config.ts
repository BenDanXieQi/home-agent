import { z } from "zod";
export const materialCollectionConfigSchema = z.object({
  poll_interval_ms: z
    .number()
    .int()
    .min(60_000)
    .max(86400_000)
    .default(300_000),
  conversation_page_size: z.number().int().min(1).max(20).default(20),
  conversation_page_budget: z.number().int().min(1).max(10).default(3),
});
