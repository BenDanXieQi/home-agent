import {
  identityCapacity,
  identityEnrollmentLimits,
} from "@home-agent/api/contracts";
import { z } from "zod";

import { identityConfigSchema } from "./config";
import { trackingObservationSchema } from "@home-agent/api/contracts";
import { imageRequestSchema } from "../detection/image-request";
import {
  referenceAppearanceSchema,
  identityClassSchema,
  identityFeatureSchema,
} from "../../household/identity/contracts";

export const extractedReferenceSchema = z.object({
  feature: identityFeatureSchema.nullable(),
  appearance: referenceAppearanceSchema.optional(),
  cropSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sharpness: z.number().nonnegative(),
  detectionScore: z.number().min(0).max(1).nullable(),
  image: z
    .string()
    .max(Math.ceil(identityEnrollmentLimits.candidateBytes / 3) * 4),
});
export const enrollmentResultSchema = z.object({
  kind: z.literal("enrollment"),
  ambiguous: z.boolean().optional(),
  candidates: z
    .array(extractedReferenceSchema)
    .max(identityCapacity.targetsPerFrame),
  reason: z.string().max(256).nullable(),
});
export const identityModelStatusSchema = z.object({
  kind: z.literal("identity_status"),
  status: z.enum(["not_checked", "available", "unavailable"]),
  reason: z.string().max(256).nullable(),
});
export const enrollmentCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("identity_status"),
    className: identityClassSchema,
  }),
  z.object({
    kind: z.literal("identity_extract"),
    config: identityConfigSchema,
    image: imageRequestSchema,
    mode: z.enum(["photo", "video_frame"]),
    className: identityClassSchema,
    regions: z
      .array(
        trackingObservationSchema.shape.tracks.element.pick({
          trackId: true,
          className: true,
          measuredBox: true,
        }),
      )
      .max(identityCapacity.targetsPerFrame),
  }),
]);
