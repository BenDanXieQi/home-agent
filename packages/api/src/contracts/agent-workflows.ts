import { z } from "zod";
import {
  automationDraftSchema,
  automationGenerationInputSchema,
  automationGenerationLimits,
} from "./automations";

export const agentWorkflowInputSchema = z.discriminatedUnion("workflow", [
  z.strictObject({
    workflow: z.literal("automation-generation"),
    input: automationGenerationInputSchema,
  }),
]);

/** Backend resolves capabilities from the active household, never from the caller. */
export const householdWorkflowInputSchema = z.strictObject({
  scope_epoch: z.uuid(),
  workflow: z.literal("automation-generation"),
  input: automationGenerationInputSchema.omit({ capabilities: true }),
});

export const agentWorkflowResultSchema = z.discriminatedUnion("workflow", [
  z.strictObject({
    workflow: z.literal("automation-generation"),
    result: automationDraftSchema,
  }),
]);

export const agentWorkflowLimits = {
  requestBytes: automationGenerationLimits.requestBytes,
  responseBytes: automationGenerationLimits.responseBytes,
  timeoutMs: automationGenerationLimits.timeoutMs,
  concurrent: automationGenerationLimits.concurrent,
} as const;
