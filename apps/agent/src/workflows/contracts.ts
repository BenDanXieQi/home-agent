import { z } from "zod";
import {
  automationDraftSchema,
  automationGenerationInputSchema,
} from "./automation-generation/contracts";
import {
  speechDialogueRequestSchema,
  speechDialogueResponseSchema,
} from "./speech-interpretation/contracts";
import {
  spatialPlanningRequestSchema,
  spatialPlanningResultSchema,
} from "./spatial-planning/contracts";
export const agentWorkflowInputSchema = z.discriminatedUnion("workflow", [
  z.strictObject({
    workflow: z.literal("automation-generation"),
    input: automationGenerationInputSchema,
  }),
  z.strictObject({
    workflow: z.literal("speech-interpretation"),
    input: speechDialogueRequestSchema,
  }),
  z.strictObject({
    workflow: z.literal("spatial-planning"),
    input: spatialPlanningRequestSchema,
  }),
]);

export const agentWorkflowResultSchema = z.discriminatedUnion("workflow", [
  z.strictObject({
    workflow: z.literal("automation-generation"),
    result: automationDraftSchema,
  }),
  z.strictObject({
    workflow: z.literal("speech-interpretation"),
    result: speechDialogueResponseSchema,
  }),
  z.strictObject({
    workflow: z.literal("spatial-planning"),
    result: spatialPlanningResultSchema,
  }),
]);
