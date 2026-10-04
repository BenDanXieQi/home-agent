import { z } from "zod";
import { identityCapacity } from "@home-agent/api/contracts";

export const featureSchema = z
  .array(z.number())
  .length(identityCapacity.featureDimensions)
  .refine(
    (vector) => Math.hypot(...vector) > 1e-12,
    "Face feature must have a nonzero norm",
  );
export const identityEvidenceSchema = z.object({
  samples: z
    .array(
      z.object({
        trackId: z.int().positive(),
        feature: featureSchema,
        cropSha256: z.string().regex(/^[a-f0-9]{64}$/),
        sharpness: z.number().nonnegative(),
        detectionScore: z.number().min(0).max(1),
      }),
    )
    .max(identityCapacity.facesPerFrame),
  qualityRejected: z.int().nonnegative(),
});
