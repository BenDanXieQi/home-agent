import type { ToolSlot } from "@earendil-works/pi-durable";
import { z } from "zod";

export const conversationProgressSchema = z.strictObject({
  session_id: z.uuid(),
  reply: z.string(),
  tools: z.array(
    // Pi exposes a type, not a runtime schema; validate only the fields we send.
    z.strictObject({
      callId: z.string(),
      name: z.string(),
      status: z.enum(["pending", "running", "done"]),
    }) satisfies z.ZodType<Pick<ToolSlot, "callId" | "name" | "status">>,
  ),
});
