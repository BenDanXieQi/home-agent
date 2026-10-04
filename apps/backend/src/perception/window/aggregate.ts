import type { z } from "zod";
import type {
  audioTrackSchema,
  windowSummarySchema,
  windowBoxSchema,
} from "@home-agent/api/contracts";
import type { sampledFrameSchema } from "./protocol";
import { evaluateScene, selectCrop, visualDifference } from "../gate/visual";
import {
  createWindowAudio,
  summarizeWindowAudio,
  trimWindowAudio,
} from "./audio-coverage";
import { windowLimits } from "./limits";

type Frame = z.infer<typeof sampledFrameSchema> &
  Pick<
    z.infer<typeof windowSummarySchema>["frames"][number],
    "detections" | "tracks" | "identity"
  >;

export function windowIdentities(
  frames: z.infer<typeof windowSummarySchema>["frames"],
) {
  const tracks = frames.flatMap((frame) => frame.identity?.tracks ?? []);
  return {
    identityCount: new Set(tracks.map((track) => track.trackId)).size,
    identityLabels: [
      ...new Set(
        tracks.flatMap((track) =>
          track.state === "confirmed" && track.label !== null
            ? [track.label]
            : [],
        ),
      ),
    ],
  };
}
export function createWindowDraft(
  startedAt: number,
  endedAt: number,
  incomplete: boolean,
) {
  return {
    startedAt,
    endedAt,
    incomplete,
    frames: [] as Frame[],
    videoRun: null as z.infer<typeof windowSummarySchema>["videoRun"],
    ...createWindowAudio(),
    gaps: new Set<string>(),
    bytes: 0,
  };
}

export function windowComparisonInterval(sampleFps: number) {
  const frameInterval = 1000 / sampleFps;
  return (
    Math.ceil(windowLimits.sampleIntervalMs / frameInterval) * frameInterval +
    windowLimits.samplingToleranceMs
  );
}

export function canCompareWindowFrames(
  previous: Frame,
  current: Frame,
  sampleFps: number,
) {
  const maximumInterval = windowComparisonInterval(sampleFps);
  return (
    previous.width === current.width &&
    previous.height === current.height &&
    previous.mediaTime.generation === current.mediaTime.generation &&
    current.sequence > previous.sequence &&
    current.receivedAt > previous.receivedAt &&
    current.receivedAt - previous.receivedAt <= maximumInterval &&
    current.mediaTime.pts > previous.mediaTime.pts &&
    (current.mediaTime.pts - previous.mediaTime.pts) / 90 <= maximumInterval
  );
}

export function summarizeWindow(
  value: ReturnType<typeof createWindowDraft>,
  entry: {
    audioTrack: z.infer<typeof audioTrackSchema> | null;
  },
  sampleFps: number,
) {
  const first = value.frames.length < 2;
  let changedRatio = 0,
    failed = value.gaps.has("capture_failed");
  const regions: z.infer<typeof windowBoxSchema>[] = [];
  const comparisons: z.infer<
    typeof windowSummarySchema
  >["gate"]["comparisons"] = [];
  const maximumInterval = windowComparisonInterval(sampleFps);
  try {
    for (const [index, frame] of value.frames.entries()) {
      const previous = value.frames[index - 1];
      if (previous && canCompareWindowFrames(previous, frame, sampleFps)) {
        const difference = visualDifference(previous.gray, frame.gray);
        comparisons.push({
          previousSequence: previous.sequence,
          currentSequence: frame.sequence,
          changedRatio: difference.ratio,
          region: difference.region,
        });
        changedRatio = Math.max(changedRatio, difference.ratio);
        if (difference.ratio >= 0.005 && difference.region) {
          regions.push(difference.region);
        }
      }
      for (const box of frame.detections ?? [])
        regions.push({
          x: box.x / frame.width,
          y: box.y / frame.height,
          w: box.w / frame.width,
          h: box.h / frame.height,
        });
      if (frame.detections === null) value.gaps.add("detection_missing");
      if (frame.tracks === null) value.gaps.add("tracking_missing");
    }
  } catch {
    failed = true;
    value.gaps.add("visual_gate_failed");
  }
  if (!value.frames.length) value.gaps.add("video_missing");
  const firstFrame = value.frames[0];
  const lastFrame = value.frames.at(-1);
  if (
    firstFrame &&
    lastFrame &&
    (firstFrame.receivedAt - value.startedAt > maximumInterval ||
      value.endedAt - lastFrame.receivedAt > maximumInterval ||
      value.frames.some((frame, index) => {
        const previous = value.frames[index - 1];
        return (
          previous !== undefined &&
          (frame.receivedAt - previous.receivedAt > maximumInterval ||
            (frame.mediaTime.pts - previous.mediaTime.pts) / 90 >
              maximumInterval)
        );
      }))
  )
    value.gaps.add("video_sampling_gap");
  const audio = summarizeWindowAudio(value, entry.audioTrack);
  const audioPassed =
    audio.status === "available" && audio.activeEnergyBlocks > 0;
  const decision = evaluateScene({
    hasVideo: value.frames.length > 0,
    failed,
    first,
    changedRatio,
    audioPassed,
  });

  return {
    audio,
    gate: { ...decision.gate, comparisons },
    crop: selectCrop(regions),
  };
}

export function truncateWindow(
  value: ReturnType<typeof createWindowDraft>,
  endedAt: number,
) {
  if (value.endedAt <= endedAt) return 0;
  const before = value.bytes;
  value.endedAt = endedAt;
  value.incomplete = true;
  value.gaps.add("source_stopped");
  value.frames = value.frames.filter((frame) => frame.receivedAt < endedAt);
  trimWindowAudio(value, endedAt);
  value.bytes =
    value.frames.reduce(
      (sum, frame) => sum + frame.rgb.byteLength + frame.gray.byteLength,
      0,
    ) + value.audio.reduce((sum, block) => sum + block.pcm.byteLength, 0);
  return before - value.bytes;
}
