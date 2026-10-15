import { z } from "zod";
import {
  apiErrorSchema,
  speechObservationSchema,
} from "@home-agent/api/contracts";
import {
  speechDecisionSchema,
  speechDialogueRequestSchema,
} from "@home-agent/agent/workflows/speech-interpretation";

export const speechInboxLimits = Object.freeze({
  entries: 64,
  timeoutMs: 12000,
});
const assistantNamesSchema = speechDialogueRequestSchema.shape.assistantNames;
export const speechDialogueConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  assistantNames: assistantNamesSchema.default(["家庭助手"]),
  callsPerMinute: z.int().min(1).max(30).default(6),
});
export const speechInboxEntrySchema = z.object({
  sequence: z.int().positive(),
  observation: speechObservationSchema,
  expiresAt: z.number(),
  status: z.enum([
    "captured",
    "pending",
    "analyzing",
    "ready",
    "ignored",
    "incomplete",
    "unavailable",
  ]),
  decision: speechDecisionSchema.nullable(),
  error: apiErrorSchema.nullable(),
});
export const speechInboxSchema = z.object({
  instanceId: z.uuid(),
  settings: speechDialogueConfigSchema,
  revision: z.int().nonnegative(),
  sequence: z.int().nonnegative(),
  rejected: z.int().nonnegative(),
  entries: z.array(speechInboxEntrySchema).max(speechInboxLimits.entries),
});
