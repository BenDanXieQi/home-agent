import { z } from "zod";
import { sourceSelectionSchema } from "./config";

export const runSchema = sourceSelectionSchema.extend({
  scopeEpoch: z.uuid(),
  runId: z.uuid(),
});
export const detectionSchema = z.object({
  x: z.int().nonnegative(),
  y: z.int().nonnegative(),
  w: z.int().positive(),
  h: z.int().positive(),
  classId: z.int().min(0).max(4),
  className: z.enum(["human", "cat", "dog", "head", "face"]),
  confidence: z.number().min(0).max(1),
});
export const observationSchema = z.object({
  run: runSchema,
  sequence: z.int().positive(),
  receivedAt: z.number(),
  sampledAt: z.number(),
  mediaTime: z.null(),
  width: z.int().positive(),
  height: z.int().positive(),
  coordinateBasis: z.literal("decoded_rgb24"),
  detections: z.array(detectionSchema).max(3549),
  ageMs: z.number().nonnegative(),
});
export function isCurrentRun(
  granted: z.infer<typeof runSchema>,
  incoming: z.infer<typeof runSchema>,
) {
  return (
    granted.runId === incoming.runId &&
    granted.scopeEpoch === incoming.scopeEpoch &&
    granted.deviceId === incoming.deviceId &&
    granted.channel === incoming.channel
  );
}
export function acceptsObservation(
  granted: z.infer<typeof runSchema>,
  previousSequence: number,
  observation: z.infer<typeof observationSchema>,
  ageMs: number,
  maxAgeMs: number,
) {
  return (
    isCurrentRun(granted, observation.run) &&
    observation.sequence > previousSequence &&
    ageMs >= 0 &&
    ageMs < maxAgeMs
  );
}
