import { appearanceEvidenceSchema } from "../../household/identity/appearance-evidence";
import { isCurrentRun } from "../observations";
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
    appearanceEvidence: z.array(appearanceEvidenceSchema).max(8).optional(),
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

// Validate frame/target binding before any internal consumer sees vectors.
export function validAppearanceEvent(
  event: Extract<z.infer<typeof videoEventSchema>, { event: "tracking" }>,
) {
  const observation = event.observation;
  const ids = new Set<number>();
  return (
    isCurrentRun(event.run, observation.run) &&
    (event.appearanceEvidence ?? []).every((evidence) => {
      const track = observation.tracks.find(
        (item) => item.trackId === evidence.trackId,
      );
      if (
        ids.has(evidence.trackId) ||
        observation.status === "failed" ||
        !isCurrentRun(observation.run, evidence.run) ||
        evidence.sequence !== observation.sequence ||
        evidence.receivedAt !== observation.receivedAt ||
        evidence.sampledAt !== observation.sampledAt ||
        evidence.ageMs !== observation.ageMs ||
        evidence.width !== observation.width ||
        evidence.height !== observation.height ||
        evidence.mediaTime.generation !== observation.mediaTime.generation ||
        evidence.mediaTime.pts !== observation.mediaTime.pts ||
        evidence.mediaTime.rtpTimestamp !==
          observation.mediaTime.rtpTimestamp ||
        track?.className !== "human" ||
        track.state !== "measured" ||
        track.feature !== "extracted" ||
        track.featureAt !== observation.receivedAt ||
        !track.measuredBox
      )
        return false;
      ids.add(evidence.trackId);
      return true;
    })
  );
}
