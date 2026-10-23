import { rm } from "node:fs/promises";
import type { Writable } from "node:stream";
import type { z } from "zod";
import type { inspectMedia } from "../media/inspection";
import type { readMediaInputSchema } from "./service";
import { RecordingCoverageError, requireCoverage } from "./selection";
import { decodedFrames, prepareTimeline } from "./timeline";
import { encodeMedia } from "./encoding";

function spatialFilters(input: z.infer<typeof readMediaInputSchema>) {
  const filters: string[] = [];
  if (input.crop) {
    const { x, y, w, h } = input.crop;
    filters.push(
      `crop=w='ceil(iw*${x + w})-floor(iw*${x})':h='ceil(ih*${y + h})-floor(ih*${y})':x='floor(iw*${x})':y='floor(ih*${y})':exact=1`,
    );
  }
  const { width, height, kind } = input.output;
  if (width || height) {
    const automatic = kind === "video" ? -2 : -1;
    filters.push(`scale=w=${width ?? automatic}:h=${height ?? automatic}`);
  } else if (kind === "video") {
    filters.push("scale=w='max(2,trunc(iw/2)*2)':h='max(2,trunc(ih/2)*2)'");
  }
  filters.push("setsar=1");
  return filters;
}

export async function transformMedia(options: {
  executable: string;
  directory: string;
  segments: readonly {
    path: string;
    startedAt: number;
    endedAt: number;
    sequence?: number;
    runId?: string;
    media: Awaited<ReturnType<typeof inspectMedia>>;
  }[];
  input: z.infer<typeof readMediaInputSchema>;
  signal: AbortSignal;
  openOutput: (path: string) => Promise<Writable>;
}) {
  const { input, signal } = options;
  signal.throwIfAborted();
  const timeline = await prepareTimeline(options);
  const { list, requestedStart, requestedEnd, seekStart, origin } = timeline;
  const { selection } = input;
  try {
    const frames = await decodedFrames(list, seekStart, requestedEnd, signal);
    requireCoverage(frames, requestedStart, requestedEnd);
    let selected: typeof frames;
    if (selection.kind === "at") {
      const closest = frames.reduce<(typeof frames)[number] | undefined>(
        (best, frame) =>
          !best ||
          Math.abs(frame.offsetMs - requestedStart) <
            Math.abs(best.offsetMs - requestedStart)
            ? frame
            : best,
        undefined,
      );
      selected = closest ? [closest] : [];
    } else {
      selected = frames.filter(
        (frame) =>
          frame.offsetMs >= requestedStart && frame.offsetMs < requestedEnd,
      );
    }
    if (!selected.length)
      throw new RecordingCoverageError(
        "Recording selection has no decoded frames",
      );
    const startedAt = origin + selected[0]!.offsetMs;
    const last = selected[selected.length - 1]!;
    const endedAt = origin + last.offsetMs + last.durationMs;
    const spatial = spatialFilters(input);
    const { files, ...details } = await encodeMedia(
      options,
      timeline,
      selected,
      spatial,
    );
    return {
      files,
      metadata: {
        ...details,
        items: files.map(({ path: _path, bytes: _bytes, ...item }) => item),
        ...(selection.kind === "range" ? { startedAt, endedAt } : {}),
      },
    };
  } finally {
    await rm(list, { force: true });
  }
}
