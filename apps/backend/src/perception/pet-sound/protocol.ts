import { audioInferenceResponse } from "../audio/inference-protocol";
import { petSoundModelSha256 } from "./model";
import { z } from "zod";
import { petSoundObservationSchema } from "@home-agent/api/contracts";
import { petSoundPolicy } from "./limits";
export const petSoundJobSchema = z.object({
  id: petSoundObservationSchema.shape.id,
  samples: z
    .instanceof(Float32Array)
    .refine(
      (samples) =>
        samples.length === petSoundPolicy.contextMs * 16 &&
        samples.every(Number.isFinite),
    ),
});
export const petSoundResultSchema = z.object({
  kind: z.literal("result"),
  id: petSoundJobSchema.shape.id,
  events: z
    .array(
      z.object({ label: z.string().max(128), score: z.number().min(0).max(1) }),
    )
    .max(527),
  elapsedMs: z.number().nonnegative(),
  rssBytes: z.number().positive(),
});

export const petSoundResponseSchema = audioInferenceResponse(
  petSoundResultSchema,
  petSoundModelSha256,
);
