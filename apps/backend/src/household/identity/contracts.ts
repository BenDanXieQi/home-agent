import { z } from "zod";
import {
  identityCapacity,
  identityModelVersionsSchema,
  identityReferenceVersionsSchema,
  imageLimits,
  referenceSourceSchema,
  referenceQualitySchema,
} from "@home-agent/api/contracts";
import { personGenderSchema } from "@home-agent/api/household-members";

export const identityClassSchema = z.enum(["human", "cat", "dog"]);
export const identityRuntimeVersionsSchema = identityModelVersionsSchema.extend(
  {
    adapters: z.object({
      human: identityModelVersionsSchema,
      cat: identityModelVersionsSchema,
      dog: identityModelVersionsSchema,
    }),
    appearance: identityModelVersionsSchema,
  },
);
export const identityFeatureSchema = z
  .array(z.number())
  .refine(
    (vector) =>
      vector.length === identityCapacity.featureDimensions ||
      vector.length === identityCapacity.petFeatureDimensions,
    "Unsupported identity feature dimensions",
  )
  .refine(
    (vector) =>
      Number.isFinite(Math.hypot(...vector)) && Math.hypot(...vector) > 1e-12,
  );
export const referenceAppearanceSchema = z.object({
  modelVersion: z.string().min(1).max(128),
  processingVersion: z.string().min(1).max(128),
  vector: z
    .array(z.number().finite())
    .length(128)
    .refine((vector) => Math.abs(Math.hypot(...vector) - 1) <= 0.001),
});
export const identityReferenceSnapshotSchema =
  identityReferenceVersionsSchema.extend({
    appearanceReferences: z
      .array(
        referenceAppearanceSchema.extend({
          sampleId: z.uuid(),
          memberId: z.uuid(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      )
      .max(identityCapacity.members * identityCapacity.referencesPerMember)
      .optional(),
    attributeGenders: z.array(personGenderSchema).max(2).optional(),
    members: z
      .array(
        z.object({
          memberId: z.uuid(),
          className: identityClassSchema,
          threshold: z.number().min(-1).max(1.000001),
          margin: z.number().min(0).max(2),
          enabled: z.boolean(),
          references: z
            .array(
              z.object({
                sampleId: z.uuid(),
                sha256: z.string().regex(/^[a-f0-9]{64}$/),
                feature: identityFeatureSchema,
              }),
            )
            .min(1)
            .max(identityCapacity.referencesPerMember),
        }),
      )
      .max(identityCapacity.members),
  });
export const referenceInputSchema = z
  .strictObject({
    memberId: z.uuid(),
    source: referenceSourceSchema,
    quality: referenceQualitySchema,
    modelVersion: z.string().min(1).max(256),
    processingVersion: z.string().min(1).max(256),
    feature: identityFeatureSchema.nullable(),
    appearance: referenceAppearanceSchema.optional(),
    contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  })
  .refine(
    (reference) =>
      reference.feature !== null || reference.appearance !== undefined,
  );

export const referenceStorageLimits = {
  imageBytes: imageLimits.maxFileBytes,
  totalBytes: 256 * 1024 * 1024,
} as const;
