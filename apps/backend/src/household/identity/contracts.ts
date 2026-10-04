import { z } from "zod";
import {
  identityFeatureSchema,
  imageLimits,
  referenceSourceSchema,
  referenceQualitySchema,
} from "@home-agent/api/contracts";

export const referenceInputSchema = z.strictObject({
  memberId: z.uuid(),
  source: referenceSourceSchema,
  quality: referenceQualitySchema,
  modelVersion: z.string().min(1).max(256),
  processingVersion: z.string().min(1).max(256),
  feature: identityFeatureSchema,
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
});

export const referenceStorageLimits = {
  imageBytes: imageLimits.maxFileBytes,
  totalBytes: 256 * 1024 * 1024,
} as const;
