import { z } from "zod";
import { identityCapacity } from "@home-agent/api/contracts";

import { identityFeatureSchema } from "@home-agent/api/contracts";
export const identityEvidenceSchema = z.object({
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
