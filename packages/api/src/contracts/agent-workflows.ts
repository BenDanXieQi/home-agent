import { z } from "zod";
import {
  automationDraftSchema,
  automationGenerationInputSchema,
} from "./automations";
import {
  speechDialogueRequestSchema,
  speechDialogueResponseSchema,
} from "./speech-dialogue";
import {
  spatialPlanningInputSchema,
  spatialPlanningRequestSchema,
  spatialPlanningResultSchema,
} from "./spatial-planning";
export {
  spatialPlanningInputSchema,
  spatialPlanningResultSchema,
  spatialPlanningRequestSchema,
  spatialPlanningScopeSchema,
  spatialPlanningStateSchema,
  spatialPlanningTurnSchema,
} from "./spatial-planning";

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

/** Backend resolves capabilities from the active household, never from the caller. */
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
