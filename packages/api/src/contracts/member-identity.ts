import identityCapacity from "./identity-capacity.json";
import { z } from "zod";
import { memberScopeSchema } from "./household-members";

export const identityEnrollmentLimits = {
  captureMs: 15_000,
  confirmationMs: 120_000,
  candidates: 12,
  candidateBytes: 256 * 1024,
  totalBytes: 3 * 1024 * 1024,
  recordingBytes: 32 * 1024 * 1024,
  extractionMs: 90_000,
  intervalMs: 1000,
} as const;

export const referenceMemberSchema = memberScopeSchema.extend({
  memberId: z.uuid(),
});
export const referenceSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("upload") }),
  z.strictObject({
    kind: z.literal("recording"),
    deviceId: z.string().min(1).max(128),
    channel: z.union([z.literal(1), z.literal(2)]),
    recordedAt: z.iso.datetime(),
    offsetMs: z.number().nonnegative(),
  }),
]);
export const referenceQualitySchema = z.object({
  sharpness: z.number().nonnegative(),
  detectionScore: z.number().min(0).max(1).nullable(),
});
export const referenceSampleSchema = z.object({
  id: z.uuid(),
  source: referenceSourceSchema,
  quality: referenceQualitySchema,
  createdAt: z.string(),
});
export const referenceListSchema = z.object({
  enabled: z.boolean(),
  enableReason: z.string().nullable(),
  model: z.enum(["unconfigured", "not_checked", "available", "unavailable"]),
  modelReason: z.string().nullable(),
  samples: z.array(referenceSampleSchema),
});
export const referenceDeleteSchema = referenceMemberSchema.extend({
  sampleId: z.uuid(),
});
export const referenceToggleSchema = referenceMemberSchema.extend({
  enabled: z.boolean(),
});
export const referenceRecordingSchema = referenceMemberSchema.extend({
  deviceId: referenceSourceSchema.options[1].shape.deviceId,
  channel: referenceSourceSchema.options[1].shape.channel,
  recordedAt: z.iso.datetime(),
});
export const referenceSessionSchema = referenceMemberSchema.extend({
  sessionId: z.uuid(),
});
export const referenceConfirmSchema = referenceSessionSchema.extend({
  candidateIds: z
    .array(z.uuid())
    .min(1)
    .max(identityCapacity.referencesPerMember)
    .refine((ids) => new Set(ids).size === ids.length),
});
export const referencePreviewSchema = z.object({
  sessionId: z.uuid(),
  memberId: z.uuid(),
  source: referenceRecordingSchema
    .pick({ deviceId: true, channel: true, recordedAt: true })
    .nullable(),
  expiresAt: z.number(),
  remainingCapacity: z.int().min(0).max(identityCapacity.referencesPerMember),
  reason: z.string().nullable(),
  candidates: z
    .array(
      z.object({
        id: z.uuid(),
        quality: referenceQualitySchema,
        offsetMs: z.number().nonnegative(),
        image: z
          .string()
          .max(32 + Math.ceil(identityEnrollmentLimits.candidateBytes / 3) * 4),
      }),
    )
    .max(identityEnrollmentLimits.candidates),
});

export const referenceSavedSchema = z.object({
  saved: z.literal(true),
  count: z.int().positive(),
});
export const referenceCancelledSchema = z.object({
  cancelled: z.literal(true),
});

export const identityModelVersionsSchema = z.object({
  modelVersion: z.string().min(1).max(256),
  processingVersion: z.string().min(1).max(256),
});
export const identityClassSchema = z.enum(["human", "cat", "dog"]);
export const identityRuntimeVersionsSchema = identityModelVersionsSchema.extend(
  {
    adapters: z.object({
      human: identityModelVersionsSchema,
      cat: identityModelVersionsSchema,
      dog: identityModelVersionsSchema,
    }),
  },
);
export const identityReferenceVersionsSchema =
  identityModelVersionsSchema.extend({
    contentVersion: z.uuid(),
    eligibilityVersion: z.uuid(),
    matchingVersion: z.uuid(),
  });
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
export const identityReferenceSnapshotSchema =
  identityReferenceVersionsSchema.extend({
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
      .min(1)
      .max(identityCapacity.members),
  });
export const identityMatchProvenanceSchema =
  identityReferenceVersionsSchema.extend({
    evidenceKey: z.string().min(1).max(512),
    sourceRunId: z.uuid(),
    sequence: z.int().positive(),
    mediaGeneration: z.string().min(1).max(256),
    rtpTimestamp: z.number(),
    trackId: z.int().positive(),
  });
