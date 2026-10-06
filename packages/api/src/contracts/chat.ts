import { z } from "zod";
import { runFailedEventSchema } from "./errors";

export const chatInputSchema = z
  .object({
    message: z.string().trim().min(1).max(16_000),
    threadId: z
      .uuid()
      .transform((id) => id.toLowerCase())
      .optional(),
  })
  .strict();

/** Internal backend-to-Agent input; public chat callers cannot select scope. */
export const agentChatInputSchema = chatInputSchema.extend({
  household_scope: z.uuid(),
});

export const chatToolNameSchema = z.enum([
  "get_household_overview",
  "query_devices",
  "get_device_state",
  "query_members",
  "get_automation_capabilities",
  "list_automations",
  "get_automation",
  "get_automation_runs",
  "generate_automation_draft",
  "save_automation",
  "delete_automation",
]);
export const chatToolPreviewLimit = 16_000;
const execution = { runId: z.uuid(), threadId: z.uuid() };
const toolExecution = {
  ...execution,
  callId: z.string(),
  name: chatToolNameSchema,
};
export const chatStreamEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("run_started"),
    ...execution,
    persistent: z.literal(true),
    traceId: z.string().optional(),
  }),
  z.object({ event: z.literal("token"), text: z.string() }),
  z.object({
    event: z.literal("tool_started"),
    ...toolExecution,
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({
    event: z.literal("tool_completed"),
    ...toolExecution,
    output: z.string().max(chatToolPreviewLimit),
    truncated: z.boolean(),
  }),
  z.object({ event: z.literal("run_completed"), ...execution }),
  z.object({ event: z.literal("run_failed"), ...runFailedEventSchema.shape }),
]);

export const chatToolCallSchema = z.object({
  callId: z.string(),
  name: chatToolNameSchema,
  input: z.record(z.string(), z.unknown()),
  output: z.string().nullable(),
  truncated: z.boolean(),
});
export const chatTurnSchema = z.object({
  id: z.string(),
  message: z.string(),
  answer: z.string(),
  tools: z.array(chatToolCallSchema),
  runId: z.string(),
  error: z.string(),
  status: z.enum(["running", "completed", "incomplete", "failed", "cancelled"]),
});
export const chatThreadSchema = z.object({
  threadId: z.uuid(),
  title: z.string().max(80),
  updatedAt: z.iso.datetime(),
  running: z.boolean(),
});
export const chatThreadCursorSchema = chatThreadSchema.pick({
  threadId: true,
  updatedAt: true,
});
export const chatHistoryListInputSchema = z.strictObject({
  before: chatThreadCursorSchema.optional(),
  limit: z.number().int().min(1).max(20).default(10),
});
export const chatHistoryListSchema = z.object({
  threads: z.array(chatThreadSchema),
  nextBefore: chatThreadCursorSchema.nullable(),
});
export const chatHistoryInputSchema = z.strictObject({
  threadId: z.uuid(),
  checkpointId: z.uuid().optional(),
  before: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(20).default(10),
});
export const chatHistorySchema = z.object({
  threadId: z.uuid(),
  checkpointId: z.uuid(),
  turns: z.array(chatTurnSchema),
  nextBefore: z.number().int().nonnegative().nullable(),
  canContinue: z.boolean(),
  running: z.boolean(),
});
export const chatHistoryResponseBytes = 4 * 1024 * 1024;
