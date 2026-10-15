import { z } from "zod";
import {
  automationDefinitionSchema,
  automationCapabilitiesSchema,
} from "@home-agent/api/automations";

export const automationDraftSchema = z.object({
  definition: automationDefinitionSchema.nullable(),
  behavior: z.string(),
  clarifications: z.array(z.string()),
});
export const automationGenerationInputSchema = z.strictObject({
  text: z.string().trim().min(1),
  definition: automationDefinitionSchema.optional(),
  capabilities: automationCapabilitiesSchema,
});
