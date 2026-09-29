import { z } from "zod";

export const householdResetRequestSchema = z
  .object({
    id: z.uuid(),
    phase: z.enum(["prepare", "finish"]),
  })
  .strict();
