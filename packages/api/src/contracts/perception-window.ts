import { z } from "zod";
import {
  trackingObservationSchema,
  detectionSchema,
  audioRunSchema,
  identityFrameSnapshotSchema,
  speechObservationSchema,
  petSoundAnalysisSchema,
} from "./perception";
import { mediaFrameTimeSchema, frameFingerprintSchema } from "./media";

export const windowSpeechSegmentLimit = 16;

export const windowPolicySchema = z.strictObject({
  retentionMs: z.int().min(1000).max(60_000).default(12_000),
});
export const mediaRepresentationSchema = z.enum([
  "image",
  "crop_image",
  "video",
  "crop_video",
  "audio",
]);
export const mediaSelectionSchema = z.strictObject({
  representation: mediaRepresentationSchema,
  includeAudio: z.boolean().default(false),
});
export const mediaRequestSchema = mediaSelectionSchema.extend({
  retry: z.boolean().default(false),
});
export const mediaStateSchema = z.enum([
  "queued",
  "not_generated",
  "generating",
  "ready",
  "failed",
  "expired",
  "evicted",
  "revoked",
]);
export const windowBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});
export const windowFrameSchema = z.object({
  sequence: z.int().positive(),
  receivedAt: z.number(),
  mediaTime: mediaFrameTimeSchema,
  fingerprint: frameFingerprintSchema.optional(),
  width: z.int().positive(),
  height: z.int().positive(),
  retainedWidth: z.int().positive(),
  retainedHeight: z.int().positive(),
  detections: z.array(detectionSchema).max(128).nullable(),
  tracks: trackingObservationSchema.shape.tracks.nullable(),
  // Null means no matching frame snapshot; disabled is an explicit snapshot.
  identity: identityFrameSnapshotSchema.nullable(),
});
export const windowSummarySchema = z.object({
  id: z.uuid(),
  revision: z.int().nonnegative(),
  run: trackingObservationSchema.shape.run,
  videoRun: trackingObservationSchema.shape.run.nullable(),
  generation: z.uuid().nullable(),
  processingVersion: z.literal("media-window-1"),
  startedAt: z.number(),
  endedAt: z.number(),
  closedAt: z.number(),
  readableUntil: z.number(),
  summaryUntil: z.number(),
  timeBasis: z.literal("host_receive"),
  synchronizationAccuracyMs: z.null(),
  incomplete: z.boolean(),
  gaps: z.array(z.string()).max(32),
  frames: z.array(windowFrameSchema).max(6),
  speech: z.object({
    enabled: z.boolean(),
    acceptingUntil: z.number(),
    segments: z.array(speechObservationSchema).max(windowSpeechSegmentLimit),
    truncated: z.boolean(),
  }),
  audio: z.object({
    status: z.enum([
      "available",
      "no_track",
      "missing",
      "insufficient_input",
      "failed",
    ]),
    run: audioRunSchema.nullable(),
    generation: z.uuid().nullable(),
    startedAt: z.number().nullable(),
    endedAt: z.number().nullable(),
    samples: z.int().nonnegative(),
    energyBlocks: z.int().nonnegative(),
    activeEnergyBlocks: z.int().nonnegative(),
    peakRms: z.number().nonnegative(),
    speechBlocks: z.int().nonnegative(),
    vad: z.enum(["speech", "no_speech", "insufficient_input", "unavailable"]),
    petSounds: petSoundAnalysisSchema.optional(),
  }),
  gate: z.object({
    candidate: z.enum(["video", "audio", "none"]),
    visual: z.enum(["first", "changed", "hold", "static", "missing", "failed"]),
    changedRatio: z.number().min(0).max(1),
    comparisons: z
      .array(
        z.object({
          previousSequence: windowFrameSchema.shape.sequence,
          currentSequence: windowFrameSchema.shape.sequence,
          changedRatio: z.number().min(0).max(1),
          region: windowBoxSchema.nullable(),
        }),
      )
      .max(5),
    holdUntil: z.number().nullable(),
    audioPassed: z.boolean(),
  }),
  crop: windowBoxSchema.nullable(),
  inputState: z.enum(["available", "expired", "evicted", "revoked"]),
});
export const windowSourceSchema = windowSummarySchema.shape.run.pick({
  scopeEpoch: true,
  deviceId: true,
  channel: true,
});
export const windowSampledMediaSchema = z.object({
  selection: mediaSelectionSchema,
  state: mediaStateSchema,
  readableUntil: z.number(),
  error: z.string().max(1024).nullable(),
});
export const windowDetailSchema = windowSummarySchema.extend({
  sampledMedia: windowSampledMediaSchema.nullable(),
});
export const windowListEntrySchema = windowDetailSchema
  .pick({
    id: true,
    revision: true,
    run: true,
    videoRun: true,
    startedAt: true,
    endedAt: true,
    readableUntil: true,
    summaryUntil: true,
    gate: true,
    incomplete: true,
    inputState: true,
    sampledMedia: true,
  })
  .extend({
    speechCount: z.int().nonnegative(),
    petSoundKinds: z
      .array(z.enum(["dog", "cat"]))
      .max(2)
      .optional(),
    identityCount: z.int().nonnegative(),
    identityLabels: z
      .array(
        identityFrameSnapshotSchema.shape.tracks.element.shape.label.unwrap(),
      )
      .max(40),
  });
export const windowListSchema = z.object({
  windows: z.array(windowListEntrySchema),
});

export const mediaViewSchema = z.object({
  windowId: z.uuid(),
  representation: mediaRepresentationSchema,
  state: mediaStateSchema,
  readableUntil: z.number(),
  mediaId: z.uuid().nullable(),
  bytes: z.int().nonnegative(),
  contentType: z.string().nullable(),
  error: z.string().max(1024).nullable(),
  parameters: z.object({
    shortSide: z.literal(512),
    sampleFps: z.literal(1),
    timestampBasis: z.literal("host_receive"),
    crop: windowBoxSchema.nullable(),
    cropPixels: z
      .object({
        left: z.int().nonnegative(),
        top: z.int().nonnegative(),
        width: z.int().positive(),
        height: z.int().positive(),
      })
      .nullable(),
    audioIncluded: z.boolean(),
    startedAt: z.number(),
    endedAt: z.number(),
    width: z.int().positive().nullable(),
    height: z.int().positive().nullable(),
    coordinateBasis: z.literal("encoded_pixels"),
    frames: z
      .array(
        z.object({
          sequence: z.int().positive(),
          offsetMs: z.number().nonnegative(),
          detections: z.array(detectionSchema).max(128).nullable(),
          identity: windowFrameSchema.shape.identity,
        }),
      )
      .max(6),
  }),
});
