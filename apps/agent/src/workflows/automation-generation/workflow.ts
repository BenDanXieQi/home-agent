import {
  automationDefinitionSchema,
  automationCapabilitiesSchema,
} from "@home-agent/api/automations";
import { z } from "zod";
import { defineWorkflow } from "../definition";
import { optionalModelRefSchema } from "../../models";
import {
  AutomationGenerationExtension,
  automationGenerationAgentName,
} from "./extension";
import { automationDraftSchema, generateAutomationDraft } from "./session";

export { automationDraftSchema } from "./session";

export const automationGenerationInputSchema = z.strictObject({
  text: z.string().trim().min(1),
  definition: automationDefinitionSchema.optional(),
  capabilities: automationCapabilitiesSchema,
});

export const contract = {
  input: automationGenerationInputSchema,
  progress: z.never(),
  result: automationDraftSchema,
};

export const extensions = [AutomationGenerationExtension] as const;

export const modelConfiguration = {
  key: "AGENT_AUTOMATION_MODEL",
  schema: optionalModelRefSchema,
} as const;

export const observation = {
  start: () => ({
    attributes: {
      "gen_ai.agent.name": automationGenerationAgentName,
      "automation.draft.valid": false,
    },
  }),
  complete: (result: z.infer<typeof automationDraftSchema>) => ({
    attributes: {
      "automation.draft.valid": result.definition !== null,
      "automation.clarification.count": result.clarifications.length,
    },
  }),
};

export function createWorkflow(context: Parameters<typeof defineWorkflow>[1]) {
  return defineWorkflow(createAutomationGenerationWorkflow, context);
}

function createAutomationGenerationWorkflow(
  dependencies: Parameters<typeof generateAutomationDraft>[0],
) {
  return {
    run: (
      input: z.infer<typeof automationGenerationInputSchema>,
      signal: AbortSignal,
    ) => generateAutomationDraft(dependencies, input, signal),
  };
}
