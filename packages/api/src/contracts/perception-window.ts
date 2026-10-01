import { z } from "zod";
import {
  trackingObservationSchema,
  detectionSchema,
  audioRunSchema,
} from "./perception";
import { mediaFrameTimeSchema } from "./media";

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
  width: z.int().positive(),
  height: z.int().positive(),
  retainedWidth: z.int().positive(),
  retainedHeight: z.int().positive(),
  detections: z.array(detectionSchema).max(128).nullable(),
  tracks: trackingObservationSchema.shape.tracks.nullable(),
});
export const windowSummarySchema = z.object({
  id: z.uuid(),
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
  frames: z.array(windowFrameSchema).max(5),
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
  }),
  gate: z.object({
    candidate: z.enum(["video", "audio", "none"]),
    visual: z.enum(["first", "changed", "hold", "static", "missing", "failed"]),
    changedRatio: z.number().min(0).max(1),
    holdUntil: z.number().nullable(),
    audioPassed: z.boolean(),
  }),
  crop: windowBoxSchema.nullable(),
  inputState: z.enum(["available", "expired", "evicted", "revoked"]),
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
        }),
      )
      .max(5),
  }),
});
