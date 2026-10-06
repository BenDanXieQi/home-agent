import { audioInferenceResponse } from "../audio/inference-protocol";
import { z } from "zod";
import { speechObservationSchema } from "@home-agent/api/contracts";
import { speechLimits, senseVoiceModel } from "./limits";
export const speechJobSchema = z.object({
  id: speechObservationSchema.shape.id,
  samples: z
    .instanceof(Float32Array)
    .refine(
      (samples) =>
        samples.length > 0 &&
        samples.length <= speechLimits.maxSegmentSamples &&
        samples.every(Number.isFinite),
    ),
});
export const speechResponseSchema = audioInferenceResponse(
  z.object({
    kind: z.literal("result"),
    id: speechJobSchema.shape.id,
    text: speechObservationSchema.shape.text,
    elapsedMs: speechObservationSchema.shape.inferenceMs,
    rssBytes: z.number().positive(),
  }),
  senseVoiceModel.sha256,
);
