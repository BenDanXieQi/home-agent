import { sourceMediaSchema, mediaFrameTimeSchema } from "./media";
import { z } from "zod";
import { stateVersionSchema } from "./household";

export const imageLimits = { maxFileBytes: 32 * 1024 * 1024 } as const;
export const frameLimits = {
  maxDimension: 8192,
  maxPixels: 3840 * 2160,
} as const;
export const detectionLabels = ["human", "cat", "dog", "head", "face"] as const;
export const detectionSchema = z.object({
  x: z.int().nonnegative(),
  y: z.int().nonnegative(),
  w: z.int().positive(),
  h: z.int().positive(),
  confidence: z.number().min(0).max(1),
  classId: z
    .int()
    .min(0)
    .max(detectionLabels.length - 1),
  className: z.enum(detectionLabels),
});
export const detectionTimingSchema = z.object({
  readMs: z.number().nonnegative(),
  decodeMs: z.number().nonnegative(),
  preprocessMs: z.number().nonnegative(),
  inferenceMs: z.number().nonnegative(),
  postprocessMs: z.number().nonnegative(),
  queueMs: z.number().nonnegative(),
  workerDispatchMs: z.number().nonnegative(),
});
export const imageDetectionResponseSchema = z.object({
  kind: z.literal("image_detected"),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.int().positive().max(frameLimits.maxDimension),
  height: z.int().positive().max(frameLimits.maxDimension),
  detections: z.array(detectionSchema),
  timing: detectionTimingSchema.extend({
    totalMs: z.number().nonnegative(),
    dispatchMs: z.number().nonnegative(),
    ipcRoundTripMs: z.number().nonnegative(),
  }),
});

const run = z.object({
  deviceId: z.string(),
  channel: z.union([z.literal(1), z.literal(2)]),
  scopeEpoch: z.uuid(),
  runId: z.uuid(),
});
const observation = z.object({
  run,
  sequence: z.int().positive(),
  receivedAt: z.number(),
  sampledAt: z.number(),
  mediaTime: mediaFrameTimeSchema,
  width: z.int().positive(),
  height: z.int().positive(),
  coordinateBasis: z.literal("decoded_rgb24"),
  ageMs: z.number().nonnegative(),
  detections: z.array(
    z.object({
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
      classId: z.int(),
      className: z.enum(["human", "cat", "dog", "head", "face"]),
      confidence: z.number().min(0).max(1),
    }),
  ),
});
const trackingBox = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});
export const trackingObservationSchema = z.object({
  run,
  sequence: z.int().positive(),
  receivedAt: z.number(),
  sampledAt: z.number(),
  mediaTime: mediaFrameTimeSchema,
  ageMs: z.number().nonnegative(),
  width: z.int().positive(),
  height: z.int().positive(),
  coordinateBasis: z.literal("decoded_rgb24"),
  status: z.enum(["tracked", "degraded", "failed"]),
  reason: z.string().max(4096).optional(),
  skippedFrames: z.int().nonnegative(),
  omittedHumans: z.int().nonnegative(),
  omittedPets: z.int().nonnegative(),
  tracks: z
    .array(
      z.object({
        trackId: z.int().positive(),
        className: z.enum(["human", "cat", "dog"]),
        state: z.enum(["measured", "predicted"]),
        measuredBox: trackingBox.nullable(),
        predictedBox: trackingBox,
        lastMeasuredAt: z.number(),
        hits: z.int().positive(),
        feature: z.enum(["extracted", "reused", "missing", "not_applicable"]),
        featureAt: z.number().nullable(),
      }),
    )
    .max(16),
});
export const perceptionSnapshotSchema = z.object({
  sequence: z.int().nonnegative(),
  householdVersion: stateVersionSchema.nullable(),
  instanceId: z.uuid(),
  rejectedRetiredResults: z.int().nonnegative(),
  status: z.string(),
  error: z.string().optional(),
  settings: z.object({
    cpuRatio: z.number().positive().max(1),
    sampleFps: z.number(),
    maxFrameAgeMs: z.number(),
    firstFrameTimeoutMs: z.number(),
    silenceTimeoutMs: z.number(),
  }),
  compute: z
    .object({
      status: z.string(),
      budget: z.object({
        availableCpus: z.int().positive(),
        cpuRatio: z.number().positive().max(1),
        workersPerProcess: z.int().positive(),
      }),
      restarts: z.number(),
      consecutiveRestarts: z.number(),
      lastError: z.string().optional(),
      processId: z.number().optional(),
      activeRequests: z.number(),
      activeRgbBytes: z.number(),
      activeImageRequests: z.number(),
    })
    .nullable(),
  model: z
    .object({ sha256: z.string(), provider: z.literal("cpu") })
    .nullable(),
  sources: z.array(
    z.object({
      source: run.pick({ deviceId: true, channel: true }),
      run: run.nullable(),
      authorizedAt: stateVersionSchema.nullable(),
      media: sourceMediaSchema.nullable(),
      status: z.string(),
      error: z.string().optional(),
      validity: z.enum(["no_data", "valid", "expired", "unavailable"]),
      observation: observation.nullable(),
      tracking: trackingObservationSchema.nullable(),
      trackingValidity: z.enum(["no_data", "valid", "expired", "unavailable"]),
      metrics: z.record(z.string(), z.number()),
    }),
  ),
});
