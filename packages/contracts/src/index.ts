import { z } from "zod";

export const healthSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("home-agent-backend"),
  runtime: z.literal("bun"),
  timestamp: z.iso.datetime(),
});

export type Health = z.infer<typeof healthSchema>;
