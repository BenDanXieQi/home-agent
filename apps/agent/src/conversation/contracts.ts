import type { ToolSlot } from "@earendil-works/pi-durable";
import { z } from "zod";

export const conversationProgressSchema = z.strictObject({
  session_id: z.uuid(),
  reply: z.string(),
  tools: z.array(
    z.strictObject({
      callId: z.string(),
      name: z.string(),
      status: z.enum(["pending", "running", "done"]),
    }) satisfies z.ZodType<Pick<ToolSlot, "callId" | "name" | "status">>,
  ),
});
