import { identityFeatureSchema } from "../../household/identity/contracts";
import { z } from "zod";
import {
  identityCapacity,
  personAttributeEvidenceSchema,
} from "@home-agent/api/contracts";

export const identityEvidenceSchema = z.object({
  attributes: z
    .array(
      personAttributeEvidenceSchema.pick({
        trackId: true,
        gender: true,
        score: true,
        modelVersion: true,
        processingVersion: true,
      }),
    )
    .max(identityCapacity.targetsPerFrame)
    .optional(),
  samples: z
    .array(
      z.object({
        trackId: z.int().positive(),
        className: z.enum(["human", "cat", "dog"]),
        feature: identityFeatureSchema,
        cropSha256: z.string().regex(/^[a-f0-9]{64}$/),
        sharpness: z.number().nonnegative(),
        detectionScore: z.number().min(0).max(1).nullable(),
      }),
    )
    .max(identityCapacity.targetsPerFrame),
  qualityRejected: z.int().nonnegative(),
});
