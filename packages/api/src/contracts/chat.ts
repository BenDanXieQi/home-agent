import { z } from "zod";
export const chatInputSchema = z.strictObject({
  message: z.string().trim().min(1),
});
export const chatResponseSchema = z.object({
  answer: z.string().min(1),
});
