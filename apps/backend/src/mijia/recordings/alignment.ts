import type { z } from "zod";
import type { windowSummarySchema } from "@home-agent/api/contracts";
import type { fingerprintRecording } from "./media";

function unknown(reason: "no_frame_mapping" | "clock_unverified") {
  return { type: "unknown" as const, reason };
}

/** Compare exact decoded frames. Host receipt times never establish alignment. */
export function alignRecordingFrames(
  window: z.infer<typeof windowSummarySchema>,
  candidates: readonly {
    startAt: number;
    mediaStartMs: number;
    frames: Awaited<ReturnType<typeof fingerprintRecording>>;
  }[],
) {
  const frames = window.frames
    .filter((frame) => frame.fingerprint !== undefined)
    .toSorted((a, b) => a.sequence - b.sequence);
  // One content match proves a frame location, not a relationship between clocks.
  if (frames.length < 2) return unknown("no_frame_mapping");
  const generation = window.generation;
  if (
    !generation ||
    frames.some((frame) => frame.mediaTime.generation !== generation)
  )
    return unknown("clock_unverified");
  const matches = [];
  for (const frame of frames) {
    const fingerprint = frame.fingerprint;
    if (
      !fingerprint ||
      fingerprint.width !== frame.width ||
      fingerprint.height !== frame.height
    )
      return unknown("no_frame_mapping");
    const locations = candidates.flatMap((candidate) =>
      candidate.frames
        .filter(
          (recorded) =>
            recorded.value === fingerprint.value &&
            recorded.width === fingerprint.width &&
            recorded.height === fingerprint.height,
        )
        .map((recorded) => ({
          sequence: frame.sequence,
          sourcePts: frame.mediaTime.pts,
          startAt: candidate.startAt,
          offsetMs: recorded.offsetMs,
          durationMs: recorded.durationMs,
          positionMs: candidate.mediaStartMs + recorded.offsetMs,
        })),
    );
    if (locations.length !== 1 || !(locations[0]!.durationMs > 0))
      return unknown("no_frame_mapping");
    matches.push(locations[0]!);
  }
  const first = matches[0]!;
  for (let index = 1; index < matches.length; index++) {
    const match = matches[index]!;
    const previous = matches[index - 1]!;
    if (
      match.sequence <= previous.sequence ||
      match.sourcePts <= previous.sourcePts ||
      match.positionMs <= previous.positionMs ||
      Math.abs(
        (match.sourcePts - first.sourcePts) / 90 -
          (match.positionMs - first.positionMs),
      ) > Math.max(first.durationMs, match.durationMs)
    )
      return unknown("clock_unverified");
  }
  return { type: "confirmed" as const, matches };
}
