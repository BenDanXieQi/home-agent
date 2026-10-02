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

export function summarizeWindow(
  value: ReturnType<typeof createWindowDraft>,
  entry: {
    baseline: {
      gray: Uint8Array;
      width: number;
      height: number;
      generation: string;
      runId: string;
    } | null;
    lastChangeAt: number | null;
    audioTrack: z.infer<typeof audioTrackSchema> | null;
  },
) {
  let baseline = entry.baseline;
  let changedAt: number | null = null;
  let changedRatio = 0,
    first = baseline === null,
    failed = value.gaps.has("capture_failed");
  const regions: z.infer<typeof windowBoxSchema>[] = [];
  try {
    for (const frame of value.frames) {
      const previous = baseline;
      if (
        previous &&
        previous.width === frame.width &&
        previous.height === frame.height &&
        previous.generation === frame.mediaTime.generation &&
        previous.runId === value.videoRun?.runId
      ) {
        const difference = visualDifference(previous.gray, frame.gray);
        changedRatio = Math.max(changedRatio, difference.ratio);
        if (difference.ratio >= 0.005 && difference.region) {
          regions.push(difference.region);
          changedAt = frame.receivedAt;
        }
      } else {
        first = true;
        changedAt = frame.receivedAt;
      }
      baseline = {
        gray: frame.gray,
        width: frame.width,
        height: frame.height,
        generation: frame.mediaTime.generation,
        runId: value.videoRun!.runId,
      };
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
  const maximumInterval =
    windowLimits.sampleIntervalMs + windowLimits.samplingToleranceMs;
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
    lastChangeAt: entry.lastChangeAt,
    changedAt,
    now: value.endedAt,
    audioPassed,
  });

  return {
    audio,
    gate: decision.gate,
    crop: selectCrop(regions),
    baseline: failed ? null : baseline,
    lastChangeAt: failed ? null : decision.lastChangeAt,
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
