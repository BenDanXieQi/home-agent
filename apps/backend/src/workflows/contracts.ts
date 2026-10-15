import { z } from "zod";
import { automationGenerationInputSchema } from "@home-agent/agent/workflows/automation-generation";
import { spatialPlanningInputSchema } from "@home-agent/agent/workflows/spatial-planning";

export const householdWorkflowInputSchema = z.discriminatedUnion("workflow", [
  z.strictObject({
    scope_epoch: z.uuid(),
    workflow: z.literal("automation-generation"),
    input: automationGenerationInputSchema.omit({ capabilities: true }),
  }),
  z.strictObject({
    scope_epoch: z.uuid(),
    workflow: z.literal("spatial-planning"),
    input: spatialPlanningInputSchema,
  }),
]);
