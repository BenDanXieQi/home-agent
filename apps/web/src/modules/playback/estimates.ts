import { z } from "zod";
import {
  playbackDurationSchema,
  playbackTargetSchema,
} from "@home-agent/api/playback";

export const playbackHistoryPolicy = {
  lifetimeMs: 24 * 60 * 60 * 1_000,
  maximumGroups: 128,
  maximumSamples: 30,
  maximumDurationMs: 300_000,
  minimumSamples: 5,
} as const;

export type PlaybackHistoryTarget = ReturnType<
  typeof playbackTargetSchema.parse
>;

export const playbackHistorySampleSchema = playbackTargetSchema.extend({
  id: z.uuid(),
  recordedAt: playbackDurationSchema,
  environment: z.string().max(256).nullable(),
  sourceRecentlyActive: z.boolean(),
  firstFrameWaitMs: playbackDurationSchema.max(
    playbackHistoryPolicy.maximumDurationMs,
  ),
});
export type PlaybackHistorySample = ReturnType<
  typeof playbackHistorySampleSchema.parse
>;

export function playbackHistoryGroupKey(
  target: PlaybackHistoryTarget,
  sourceRecentlyActive: boolean,
) {
  return JSON.stringify([
    target.deviceId,
    target.channel,
    sourceRecentlyActive,
  ]);
}

function isRecentSample(sample: PlaybackHistorySample, now: number) {
  return (
    sample.recordedAt <= now &&
    now - sample.recordedAt < playbackHistoryPolicy.lifetimeMs
  );
}

export function mergePlaybackHistorySamples(
  samples: readonly PlaybackHistorySample[],
  now: number,
) {
  const seen = new Set<string>();
  return samples
    .filter((sample) => isRecentSample(sample, now))
    .toSorted((left, right) => right.recordedAt - left.recordedAt)
    .filter((sample) => {
      if (seen.has(sample.id)) return false;
      seen.add(sample.id);
      return true;
    })
    .slice(0, playbackHistoryPolicy.maximumSamples);
}

export function estimateRemainingPlaybackTime(
  samples: readonly PlaybackHistorySample[],
  {
    elapsedMs,
    now,
  }: {
    elapsedMs: number;
    now: number;
  },
) {
  if (
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0 ||
    elapsedMs >= playbackHistoryPolicy.maximumDurationMs ||
    !Number.isFinite(now) ||
    now < 0
  )
    return null;
  const remaining = samples
    .filter(
      (sample) =>
        isRecentSample(sample, now) && sample.firstFrameWaitMs > elapsedMs,
    )
    .map((sample) => sample.firstFrameWaitMs - elapsedMs)
    .toSorted((left, right) => left - right);
  if (remaining.length < playbackHistoryPolicy.minimumSamples) return null;
  const lower = remaining.at(Math.floor((remaining.length - 1) * 0.25));
  const upper = remaining.at(Math.ceil((remaining.length - 1) * 0.9));
  if (lower === undefined || upper === undefined) return null;
  return {
    lowerMs: Math.floor(lower),
    upperMs: Math.ceil(upper),
    samples: remaining.length,
  };
}
