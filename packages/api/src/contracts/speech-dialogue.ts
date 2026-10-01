import { z } from "zod";
import { apiErrorSchema } from "./errors";
import { speechObservationSchema } from "./perception";

export const speechDialogueLimits = Object.freeze({
  entries: 64,
  contextSegments: 3,
  lifetimeMs: 45000,
  timeoutMs: 12000,
  requestBytes: 98304,
  responseBytes: 24576,
});
export const speechDialogueConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  assistantNames: z
    .array(z.string().trim().min(1).max(32))
    .min(1)
    .max(8)
    .default(["家庭助手"]),
  callsPerMinute: z.int().min(1).max(30).default(6),
});
export const speechDecisionSchema = z.object({
  needsResponse: z.boolean(),
  isComplete: z.boolean(),
  category: z.enum(["assistant_request", "conversation", "media", "uncertain"]),
  requestText: z.string().trim().min(1).max(4096).nullable(),
  reason: z.string().min(1).max(512),
});
export function validSpeechDecision(
  decision: z.infer<typeof speechDecisionSchema>,
) {
  const request =
    decision.needsResponse &&
    decision.isComplete &&
    decision.category === "assistant_request";
  return (
    (decision.requestText !== null) === request &&
    decision.needsResponse === (decision.category === "assistant_request")
  );
}
export const speechDialogueRequestSchema = z.object({
  id: z.uuid(),
  expiresAt: z.number(),
  assistantNames: speechDialogueConfigSchema.shape.assistantNames,
  current: speechObservationSchema,
  preceding: z
    .array(speechObservationSchema)
    .max(speechDialogueLimits.contextSegments),
});
export function validSpeechDialogueRequest(
  input: z.infer<typeof speechDialogueRequestSchema>,
  now: number,
) {
  const current = input.current;
  const coherent = (item: typeof current) =>
    item.startSample < item.speechEndSample &&
    item.speechEndSample <= item.endSample &&
    item.observedStartAt <= item.observedEndAt;
  return (
    input.expiresAt > now &&
    input.expiresAt <=
      current.observedEndAt + speechDialogueLimits.lifetimeMs &&
    current.observedEndAt <= now + 2000 &&
    Boolean(current.text.trim()) &&
    coherent(current) &&
    new Set([current.id, ...input.preceding.map((item) => item.id)]).size ===
      input.preceding.length + 1 &&
    input.preceding.every(
      (item) =>
        coherent(item) &&
        item.run.trackRunId === current.run.trackRunId &&
        item.run.scopeEpoch === current.run.scopeEpoch &&
        item.run.deviceId === current.run.deviceId &&
        item.generation === current.generation &&
        item.endSample <= current.startSample &&
        now - item.observedEndAt < speechDialogueLimits.lifetimeMs,
    )
  );
}
export const speechDialogueResponseSchema = z.object({
  id: z.uuid(),
  observationId: speechObservationSchema.shape.id,
  decision: speechDecisionSchema,
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
    "expired",
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
  entries: z.array(speechInboxEntrySchema).max(speechDialogueLimits.entries),
});
