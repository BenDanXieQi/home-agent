import type { z } from "zod";
import type { readMediaInputSchema } from "./service";

export function selectSegments<
  T extends { startedAt: number; endedAt: number },
>(entries: T[], selection: z.infer<typeof readMediaInputSchema>["selection"]) {
  const sorted = entries.toSorted((a, b) => a.startedAt - b.startedAt);
  const start = selection.kind === "at" ? selection.at : selection.start;
  const end = selection.kind === "at" ? start + 0.001 : selection.end;
  const first = sorted.findIndex(
    (entry) => entry.endedAt > start && entry.startedAt < end,
  );
  if (first < 0) return [];
  const last = sorted.findLastIndex(
    (entry) => entry.endedAt > start && entry.startedAt < end,
  );
  return sorted.slice(
    Math.max(0, first - 1),
    last + (selection.kind === "at" ? 2 : 1),
  );
}

export class RecordingCoverageError extends Error {}

export function requireCoverage(
  frames: { offsetMs: number; durationMs: number }[],
  start: number,
  end: number,
) {
  let covered = start;
  for (const frame of frames) {
    const frameEnd = frame.offsetMs + frame.durationMs;
    if (frameEnd <= covered) continue;
    if (frame.offsetMs > covered + 0.1)
      throw new RecordingCoverageError(
        "Recording decoded frames do not cover the selection",
      );
    covered = frameEnd;
    if (covered >= end - 0.1) return;
  }
  throw new RecordingCoverageError(
    "Recording decoded frames do not cover the selection",
  );
}
