import { sourceMediaSchema, mediaFrameTimeSchema } from "./media";
import { z } from "zod";
import { stateVersionSchema } from "./household";

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
export const audioRunSchema = z.object({
  deviceId: z.string().regex(/^[0-9]{1,32}$/),
  scopeEpoch: z.uuid(),
  trackRunId: z.uuid(),
});
const sampleInterval = z.object({
  startSample: z.int().nonnegative(),
  endSample: z.int().positive(),
});
export const audioTrackSchema = z.object({
  run: audioRunSchema,
  channels: z
    .array(z.union([z.literal(1), z.literal(2)]))
    .min(1)
    .max(2),
  status: z.enum(["starting", "reading", "no_track", "failed", "unavailable"]),
  error: z.string().max(4096).optional(),
  generation: z.uuid().nullable(),
  anchorReceivedAt: z.number().nullable(),
  decodedStartOffsetMs: z.number().nonnegative().max(1000),
  timeQuality: z.literal("host_receive_anchor"),
  synchronizationAccuracyMs: z.null(),
  sampleRate: z.literal(16000),
  receivedAt: z.number().nullable(),
  observedAt: z.number().nullable(),
  sequence: z.int().nonnegative(),
  samples: z.int().nonnegative(),
  energy: z
    .array(
      sampleInterval.extend({
        rms: z.number().min(0).max(1),
        active: z.boolean(),
      }),
    )
    .max(8),
  vad: z
    .array(
      sampleInterval.extend({
        probability: z.number().min(0).max(1),
        aboveThreshold: z.boolean(),
      }),
    )
    .max(8),
  vadStatus: z.enum(["insufficient_input", "ready", "unavailable"]),
  vadError: z.string().max(4096).optional(),
  energyRemainder: z.int().min(0).max(479),
  vadRemainder: z.int().min(0).max(511),
  validity: z.enum(["no_data", "valid", "expired", "unavailable"]),
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
  audio: z.object({
    status: z.enum([
      "disabled",
      "starting",
      "running",
      "unavailable",
      "closed",
    ]),
    processId: z.int().positive().optional(),
    model: z
      .object({ sha256: z.string(), provider: z.literal("cpu") })
      .nullable(),
    error: z.string().max(4096).optional(),
    tracks: z.array(audioTrackSchema).max(8),
  }),
  sources: z.array(
    z.object({
      audioTrackRunId: z.uuid().nullable(),
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
