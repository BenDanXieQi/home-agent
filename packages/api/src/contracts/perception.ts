import {
  identityReferenceVersionsSchema,
  identityMatchProvenanceSchema,
} from "./member-identity";
import { sourceMediaSchema, mediaFrameTimeSchema } from "./media";
import { z } from "zod";
import identityCapacity from "./identity-capacity.json";
export { identityCapacity };
import { stateVersionSchema } from "./household";

export const imageLimits = {
  maxFileBytes: 32 * 1024 * 1024,
  processingTimeoutMs: 10_000,
} as const;
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
  deviceId: z.string().min(1).max(128),
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
// These are local face-reference observations, not authoritative household identities.
const identityTrackSchema = z.object({
  trackId: z.int().positive(),
  state: z.enum(["unknown", "candidate", "confirmed", "conflict"]),
  label: z.string().max(identityCapacity.labelLength).nullable(),
  reason: z.string().max(256),
  samples: z.int().nonnegative().max(identityCapacity.samplesPerTrack),
  supportingSamples: z
    .int()
    .nonnegative()
    .max(identityCapacity.samplesPerTrack),
  score: z.number().min(-1).max(1).nullable(),
  margin: z.number().min(0).max(2).nullable(),
  firstSeenAt: z.number(),
  lastSeenAt: z.number(),
  lastEvidenceAt: z.number().nullable(),
  evidence: z
    .array(
      z.object({
        provenance: identityMatchProvenanceSchema,
        bestMemberId: z.uuid().nullable(),
        observedAt: z.number(),
        label: z.string().max(identityCapacity.labelLength).nullable(),
        score: z.number().min(-1).max(1).nullable(),
        margin: z.number().min(0).max(2).nullable(),
        detectionScore: z.number().min(0).max(1).nullable(),
        sharpness: z.number().nonnegative(),
      }),
    )
    .max(identityCapacity.samplesPerTrack),
  confirmedAt: z.number().nullable(),
  expiresAt: z.number().nullable(),
});
export const identityObservationSchema = trackingObservationSchema
  .pick({
    run: true,
    sequence: true,
    receivedAt: true,
    sampledAt: true,
    mediaTime: true,
    ageMs: true,
    width: true,
    height: true,
    coordinateBasis: true,
  })
  .extend({
    revision: z.int().positive(),
    status: z.enum([
      "idle",
      "starting",
      "unloading",
      "collecting",
      "recognizing",
      "unavailable",
    ]),
    error: z.string().max(4096).optional(),
    referenceRevision: z.string().nullable(),
    referenceVersions: identityReferenceVersionsSchema.nullable(),
    model: z
      .object({
        processId: z.int().positive().optional(),
        engine: z.literal("opencv-wasm-onnxruntime"),
        provider: z.literal("cpu"),
        version: z.string(),
        yunetSha256: z.string(),
        sfaceSha256: z.string(),
        petSha256: z.string(),
      })
      .nullable(),
    tracks: z.array(identityTrackSchema).max(identityCapacity.tracksPerRun),
    recent: z
      .array(identityTrackSchema.extend({ endedAt: z.number() }))
      .max(identityCapacity.recentTracks),
    statistics: z.object({
      frames: z.int().nonnegative(),
      sampledFrames: z.int().nonnegative(),
      skippedBusy: z.int().nonnegative(),
      skippedNoPixels: z.int().nonnegative(),
      skippedIncompleteTracking: z.int().nonnegative(),
      acceptedSamples: z.int().nonnegative(),
      duplicateSamples: z.int().nonnegative(),
      qualityRejected: z.int().nonnegative(),
      conflicts: z.int().nonnegative(),
      tracksSeen: z.int().nonnegative(),
      confirmedTracks: z.int().nonnegative(),
      confirmationDelayMsTotal: z.number().nonnegative(),
    }),
  });
// Public summaries preserve provenance without features or media bytes.
export const appearanceSummarySchema = trackingObservationSchema
  .pick({
    run: true,
    sequence: true,
    receivedAt: true,
    sampledAt: true,
    mediaTime: true,
    ageMs: true,
    width: true,
    height: true,
    coordinateBasis: true,
  })
  .extend({
    trackId: z.int().positive(),
    modelVersion: z.string().min(1).max(128),
    processingVersion: z.string().min(1).max(128),
  });
export const appearanceReferenceSchema = z.object({
  referenceId: z.uuid(),
  sourceTargetKey: z.string().min(1).max(1024),
  memberId: z.uuid(),
  face: identityTrackSchema.shape.evidence.element,
  referenceVersions: identityReferenceVersionsSchema,
  appearance: appearanceSummarySchema,
  observedAt: z.number(),
  expiresAt: z.number(),
});
const associationTarget = z.object({
  run,
  mediaGeneration: z.string().min(1).max(256),
  sourceRunId: z.uuid(),
  trackId: z.int().positive(),
  memberId: z.uuid(),
  memberName: z.string().max(256),
  observedAt: z.number(),
  expiresAt: z.number(),
});
export const memberAssociationSchema = z.discriminatedUnion("basis", [
  associationTarget.extend({
    basis: z.literal("species"),
    memberKind: z.literal("pet"),
    className: z.enum(["cat", "dog"]),
    state: z.literal("inferred"),
    eligibilityVersion: z.uuid(),
    evidence: z
      .array(
        appearanceSummarySchema
          .omit({ modelVersion: true, processingVersion: true })
          .extend({
            measuredBox: trackingBox,
          }),
      )
      .length(1),
  }),
  associationTarget.extend({
    basis: z.literal("face"),
    memberKind: z.literal("person"),
    className: z.literal("human"),
    state: z.enum(["candidate", "confirmed", "inferred"]),
    referenceVersions: identityReferenceVersionsSchema,
    evidence: identityTrackSchema.shape.evidence.min(1),
  }),
  associationTarget.extend({
    basis: z.literal("pet"),
    memberKind: z.literal("pet"),
    className: z.enum(["cat", "dog"]),
    state: z.enum(["candidate", "confirmed", "inferred"]),
    referenceVersions: identityReferenceVersionsSchema,
    evidence: identityTrackSchema.shape.evidence.min(1),
  }),
  associationTarget.extend({
    basis: z.literal("appearance"),
    memberKind: z.literal("person"),
    className: z.literal("human"),
    state: z.literal("inferred"),
    referenceIds: z.array(z.uuid()).length(1),
    references: z.array(appearanceReferenceSchema).length(1),
    evidence: z.array(appearanceSummarySchema).length(2),
    score: z.number().min(-1).max(1),
    margin: z.number().min(0).max(2),
    policyVersion: z.string().min(1).max(128),
  }),
]);
export const attributionTriggerSchema = z.object({
  sourceTargetKey: z.string().min(1).max(1024),
  referenceIds: z.array(z.uuid()).max(5),
  references: z.array(appearanceReferenceSchema).max(5),
  reason: z.enum([
    "target_face_conflict",
    "face_conflict",
    "identity_replaced",
    "terminal_identity_unavailable",
  ]),
  trigger: z
    .object({
      observation: identityObservationSchema.pick({
        revision: true,
        run: true,
        sequence: true,
        mediaTime: true,
      }),
      track: identityTrackSchema.extend({ endedAt: z.number().optional() }),
      omittedEvidence: z.int().nonnegative(),
    })
    .nullable(),
});
export const memberAttributionSnapshotSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("known"),
    association: memberAssociationSchema,
    acceptedAt: z.number(),
  }),
  z.object({
    kind: z.literal("unknown"),
    reason: z.enum(["reference_revoked", "target_face_conflict"]),
    observedAt: z.number(),
    acceptedAt: z.number(),
    trigger: attributionTriggerSchema,
  }),
]);
export const memberActivityAttributionSchema = z.object({
  original: memberAttributionSnapshotSchema,
  current: memberAttributionSnapshotSchema,
  revision: z.int().positive(),
  correctionCount: z.int().nonnegative(),
  lastCorrection: z
    .object({
      before: memberAttributionSnapshotSchema,
      after: memberAttributionSnapshotSchema,
      reason: z.enum([
        "member_changed",
        "direct_confirmation",
        "reference_revoked",
        "target_face_conflict",
      ]),
      trigger: z.union([memberAssociationSchema, attributionTriggerSchema]),
      processedAt: z.number(),
    })
    .nullable(),
});
export const memberActivityDataSchema = z.object({
  sourceRunId: z.uuid(),
  run,
  mediaGeneration: z.string().min(1).max(256),
  trackId: z.int().positive(),
  deviceId: run.shape.deviceId,
  channel: run.shape.channel,
  deviceName: z.string().max(1024),
  cameraRoomName: z.string().max(1024).nullable(),
  firstObservedAt: z.number(),
  lastObservedAt: z.number(),
  endedAt: z.number().nullable(),
  timeBasis: z.literal("host_received_at"),
  attribution: memberActivityAttributionSchema,
});
// Frozen at tracking completion; pending describes that moment, not live work.
export const identityFrameSnapshotSchema = z.object({
  status: identityObservationSchema.shape.status.or(z.literal("disabled")),
  evaluatedAt: z.number(),
  inference: z.enum(["not_requested", "pending"]),
  referenceRevision: identityObservationSchema.shape.referenceRevision,
  referenceVersions: identityObservationSchema.shape.referenceVersions,
  tracks: z
    .array(
      identityTrackSchema.pick({
        trackId: true,
        state: true,
        label: true,
        reason: true,
        supportingSamples: true,
        score: true,
        margin: true,
        lastEvidenceAt: true,
        confirmedAt: true,
        expiresAt: true,
      }),
    )
    .max(identityCapacity.tracksPerRun),
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
export const speechConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  idleUnloadMs: z.int().min(5000).max(3600000).default(60000),
});
export const speechObservationSchema = z
  .object({
    id: z.string().min(1).max(128),
    run: audioRunSchema,
    generation: z.uuid(),
    startSample: z.int().nonnegative(),
    endSample: z.int().positive(),
    speechEndSample: z.int().positive(),
    boundary: z.enum(["pause", "length_limit"]),
    observedStartAt: z.number(),
    observedEndAt: z.number(),
    completedAt: z.number(),
    text: z.string().max(4096),
    modelSha256: z.string().regex(/^[a-f0-9]{64}$/),
    processingVersion: z.literal("sensevoice-silero-frame-processor"),
    inferenceMs: z.number().nonnegative(),
  })
  .refine(
    (speech) =>
      speech.startSample < speech.speechEndSample &&
      speech.speechEndSample <= speech.endSample &&
      speech.observedStartAt <= speech.observedEndAt,
    "Inconsistent speech observation interval",
  );
export const speechTrackSchema = z.object({
  status: z.enum([
    "listening",
    "collecting",
    "queued",
    "recognizing",
    "unavailable",
  ]),
  latest: speechObservationSchema.nullable(),
  validity: z.enum(["no_data", "valid", "expired", "unavailable"]),
  dropped: z.int().nonnegative(),
  error: z.string().max(4096).optional(),
});
export const speechRuntimeSchema = z.object({
  status: z.enum([
    "sleeping",
    "loading",
    "ready",
    "recognizing",
    "unloading",
    "recovering",
    "unavailable",
    "closed",
  ]),
  processId: z.int().positive().optional(),
  processRssBytes: z.number().nonnegative().nullable(),
  modelSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  idleUnloadMs: z.int().positive(),
  loads: z.int().nonnegative(),
  failures: z.int().nonnegative(),
  queueDepth: z.int().nonnegative().max(8),
  queueBytes: z.int().nonnegative(),
  inFlight: z.boolean(),
  completed: z.int().nonnegative(),
  dropped: z.int().nonnegative(),
  cancelled: z.int().nonnegative(),
  inboxUnconfirmed: z.int().nonnegative(),
  error: z.string().max(4096).optional(),
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
  speech: speechTrackSchema.optional(),
  energyRemainder: z.int().min(0).max(479),
  vadRemainder: z.int().min(0).max(511),
  validity: z.enum(["no_data", "valid", "expired", "unavailable"]),
});
export const perceptionResourceSchema = z.object({
  nativeThreads: z.int().positive(),
  videoWorkers: z.int().positive(),
  audioThreads: z.int().nonnegative(),
  speechThreads: z.int().nonnegative(),
  identityThreads: z.int().nonnegative(),
  modelMemoryMiB: z.int().positive(),
  reservedModelMiB: z.int().positive(),
});
export const perceptionSnapshotSchema = z.object({
  resources: perceptionResourceSchema.nullable(),
  sequence: z.int().nonnegative(),
  householdVersion: stateVersionSchema.nullable(),
  instanceId: z.uuid(),
  rejectedRetiredResults: z.int().nonnegative(),
  status: z.string(),
  error: z.string().optional(),
  settings: z.object({
    cpuRatio: z.number().positive().max(1),
    modelMemoryMiB: z.int().positive(),
    speech: speechConfigSchema,
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
    speech: speechRuntimeSchema.optional(),
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
      identity: identityObservationSchema
        .omit({ recent: true })
        .extend({
          tracks: z
            .array(identityTrackSchema.omit({ evidence: true }))
            .max(identityCapacity.tracksPerRun),
        })
        .nullable(),
      associations: z
        .array(memberAssociationSchema)
        .max(identityCapacity.tracksPerRun),
      identityValidity: z.enum(["no_data", "valid", "expired", "unavailable"]),
      trackingValidity: z.enum(["no_data", "valid", "expired", "unavailable"]),
      metrics: z.record(z.string(), z.number()),
    }),
  ),
});
