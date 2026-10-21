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
  uploadBytes: 32 * 1024 * 1024,
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
  features: z.array(z.enum(["face", "body", "pet"])).max(2),
  outdated: z.boolean(),
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
export const referenceSessionSchema = referenceMemberSchema.extend({
  sessionId: z.uuid(),
});
export const referenceRecordingSchema = referenceSessionSchema.extend({
  deviceId: referenceSourceSchema.options[1].shape.deviceId,
  channel: referenceSourceSchema.options[1].shape.channel,
  recordedAt: z.iso.datetime(),
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
  uploads: z
    .array(
      z.object({
        fileName: z.string().max(512),
        candidateIds: z
          .array(z.uuid())
          .max(identityEnrollmentLimits.candidates),
        reason: z.string().nullable(),
      }),
    )
    .max(identityEnrollmentLimits.candidates),
  candidates: z
    .array(
      z.object({
        id: z.uuid(),
        features: referenceSampleSchema.shape.features,
        quality: referenceQualitySchema,
        offsetMs: z.number().nonnegative(),
        fileName: z.string().max(512).nullable(),
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
export const identityReferenceVersionsSchema =
  identityModelVersionsSchema.extend({
    revision: z.uuid(),
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
