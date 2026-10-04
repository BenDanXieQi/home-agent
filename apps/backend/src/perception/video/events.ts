import {
  windowFrameEventSchema,
  windowGapEventSchema,
} from "../window/protocol";
import {
  sourceMediaSchema,
  identityObservationSchema,
  identityFrameSnapshotSchema,
  trackingObservationSchema,
  windowFrameSchema,
} from "@home-agent/api/contracts";
import { z } from "zod";
import { runSchema, observationSchema } from "../observations";
import { videoMetricsSchema } from "./metrics";

export const videoEventSchema = z.discriminatedUnion("event", [
  windowFrameEventSchema,
  windowGapEventSchema,
  z.object({
    event: z.literal("identity_frame"),
    run: runSchema,
    frame: windowFrameSchema.pick({
      sequence: true,
      receivedAt: true,
      mediaTime: true,
      width: true,
      height: true,
    }),
    identity: identityFrameSnapshotSchema,
  }),
  z.object({
    event: z.literal("identity"),
    run: runSchema,
    observation: identityObservationSchema,
  }),
  z.object({
    event: z.literal("media"),
    run: runSchema,
    media: sourceMediaSchema,
  }),
  z.object({
    event: z.literal("tracking"),
    run: runSchema,
    observation: trackingObservationSchema,
  }),
  z.object({
    event: z.literal("submitted"),
    metrics: videoMetricsSchema,
    run: runSchema,
    sequence: z.int().positive(),
  }),
  z.object({
    event: z.literal("settled"),
    metrics: videoMetricsSchema,
    run: runSchema,
    sequence: z.int().positive(),
    observation: observationSchema.optional(),
  }),
  z.object({
    event: z.literal("health"),
    run: runSchema,
    status: z.enum(["reading", "failed"]),
    error: z.string().max(4096).optional(),
    metrics: videoMetricsSchema,
  }),
]);
