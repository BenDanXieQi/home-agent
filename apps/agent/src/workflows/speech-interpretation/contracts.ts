import { z } from "zod";
import { speechObservationSchema } from "@home-agent/api/contracts";

export const speechDialogueLimits = Object.freeze({
  contextSegments: 3,
  lifetimeMs: 45000,
});
const assistantNamesSchema = z
  .array(z.string().trim().min(1).max(32))
  .min(1)
  .max(8);

export const speechDecisionSchema = z
  .object({
    needsResponse: z.boolean(),
    isComplete: z.boolean(),
    category: z.enum([
      "assistant_request",
      "conversation",
      "media",
      "uncertain",
    ]),
    requestText: z.string().trim().min(1).nullable(),
    reason: z.string().min(1),
  })
  .refine(
    (decision) =>
      decision.needsResponse === (decision.category === "assistant_request") &&
      (decision.requestText !== null) ===
        (decision.needsResponse && decision.isComplete),
    "Inconsistent speech interpretation",
  );
export const speechDialogueRequestSchema = z.object({
  id: z.uuid(),
  expiresAt: z.number(),
  assistantNames: assistantNamesSchema,
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
  return (
    input.expiresAt > now &&
    input.expiresAt <=
      current.observedEndAt + speechDialogueLimits.lifetimeMs &&
    current.observedEndAt <= now + 2000 &&
    Boolean(current.text.trim()) &&
    new Set([current.id, ...input.preceding.map((item) => item.id)]).size ===
      input.preceding.length + 1 &&
    input.preceding.every(
      (item) =>
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
