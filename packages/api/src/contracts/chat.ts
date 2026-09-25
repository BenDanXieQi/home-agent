import { z } from "zod";

export const chatInputSchema = z
  .object({
    message: z.string().trim().min(1).max(16_000),
    threadId: z
      .uuid()
      .transform((id) => id.toLowerCase())
      .optional(),
  })
  .strict();
