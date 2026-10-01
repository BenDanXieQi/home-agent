import { z } from "zod";
import { speechLimits, senseVoiceModel } from "./limits";
export const speechJobSchema = z.object({
  id: z.string().min(1).max(128),
  samples: z
    .instanceof(Float32Array)
    .refine(
      (samples) =>
        samples.length > 0 &&
        samples.length <= speechLimits.maxSegmentSamples &&
        samples.every(Number.isFinite),
    ),
});
export const speechResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ready"),
    modelSha256: z.literal(senseVoiceModel.sha256),
    rssBytes: z.number().positive(),
  }),
  z.object({
    kind: z.literal("result"),
    id: speechJobSchema.shape.id,
    text: z.string().max(4096),
    elapsedMs: z.number().nonnegative(),
    rssBytes: z.number().positive(),
  }),
  z.object({ kind: z.literal("pulse"), rssBytes: z.number().positive() }),
  z.object({ kind: z.literal("fatal"), error: z.string().max(4096) }),
]);
