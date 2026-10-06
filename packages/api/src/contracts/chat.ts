import { z } from "zod";
export const chatInputSchema = z.strictObject({
  message: z.string().trim().min(1).max(16000),
});
export const chatResponseSchema = z.object({
  answer: z.string().min(1).max(65536),
});
