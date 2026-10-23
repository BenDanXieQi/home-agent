import { addAbortListener } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { MediaCleanupError } from "../media/resources";
import { MijiaError } from "../mijia/errors";
import type { createRecordingsService, readMediaInputSchema } from "./service";
import type { createRecordingOriginals } from "./originals";
import { selectSegments, RecordingCoverageError } from "./selection";
import { transformMedia } from "./transform";

async function sdSegments(
  input: z.infer<typeof readMediaInputSchema>,
  operation: Awaited<
    ReturnType<ReturnType<typeof createRecordingOriginals>["beginRead"]>
  >,
  signal: AbortSignal,
  sd: Parameters<typeof createRecordingsService>[0]["sd"],
) {
  const current = sd.current(input.deviceId, input.channel);
  const access = current.source;
  const start =
    input.selection.kind === "at" ? input.selection.at : input.selection.start;
  const end =
    input.selection.kind === "at"
      ? input.selection.at + 0.001
      : input.selection.end;
  // SD durations occupy eight bits; include the covering clip and its predecessor.
  let afterMs = Math.max(0, Math.floor(start - 2 * 255_000 - 1));
  const candidates: { startedAt: number; endedAt: number }[] = [];
  while (true) {
    const index = await sd.index(current, { afterMs, limit: 1000 }, signal);
    if (index.status !== "ready") throw new MijiaError("camera_failed");
    candidates.push(
      ...index.recordings.map((clip) => ({
        startedAt: clip.startAt,
        endedAt: clip.endAt,
      })),
    );
    if (
      index.nextAfterMs === null ||
      index.recordings.some((clip) => clip.startAt >= end)
    )
      break;
    afterMs = index.nextAfterMs;
  }
  const segments: Parameters<typeof transformMedia>[0]["segments"][number][] =
    [];
  for (const clip of selectSegments(candidates, input.selection)) {
    const raw = await operation.borrowSd(
      { ...current, startAt: clip.startedAt },
      access,
    );
    segments.push({
      path: raw.path,
      startedAt: clip.startedAt,
      endedAt: clip.startedAt + raw.media.actualDurationMs,
      media: raw.media.recording,
    });
  }
  return segments;
}

export async function readRecordingMedia(
  input: z.infer<typeof readMediaInputSchema>,
  options: {
    storage: ReturnType<
      Parameters<typeof createRecordingOriginals>[0]["storage"]
    >;
    originals: ReturnType<typeof createRecordingOriginals>;
    sd: Parameters<typeof createRecordingsService>[0]["sd"];
    executable: string;
    signal: AbortSignal;
  },
) {
  const { resources: budget, root } = options.storage;
  const cancelled = new AbortController();
  const signal = AbortSignal.any([options.signal, cancelled.signal]);
  const operation = options.originals.beginRead({
    signal,
    cancel: (reason) => cancelled.abort(reason),
  });
  const output = budget.create(null, () => {});
  const releaseOutput = budget.use(output);
  let generation:
    | Promise<Awaited<ReturnType<typeof transformMedia>>>
    | undefined;
  let cleanup: Promise<void> | undefined;
  let ready = false;

  function dispose() {
    cleanup ??= Promise.resolve().then(async () => {
      abort[Symbol.dispose]();
      cancelled.abort(new Error("Recording request released"));
      if (generation) await Promise.allSettled([generation]);
      releaseOutput();
      try {
        await budget.retire(output, "cancelled");
      } finally {
        await operation.release();
      }
    });
    return cleanup;
  }
  const abort = addAbortListener(signal, () => {
    if (ready)
      dispose().catch((cause: unknown) =>
        console.error("Recording response cleanup failed", cause),
      );
  });

  try {
    const segments =
      input.source === "sd"
        ? await sdSegments(input, operation, signal, options.sd)
        : operation.localSegments(input);
    if (!segments.length)
      throw new RecordingCoverageError("Recording selection has no material");
    const directory = await mkdtemp(join(root, "read-"));
    budget.claim(output, directory, true);
    signal.throwIfAborted();
    generation = transformMedia({
      executable: options.executable,
      directory,
      segments,
      input,
      signal,
      openOutput: async (path) => budget.openWriter(output, signal, path),
    });
    const transformed = await generation;
    await budget.publish(
      output,
      directory,
      transformed.files.reduce((sum, file) => sum + file.bytes, 0),
    );
    operation.releaseOriginals();
    signal.throwIfAborted();
    let remaining = transformed.files.length;
    const media = transformed.files.map((file) =>
      budget.read(
        output,
        signal,
        undefined,
        () => {
          if (--remaining === 0)
            dispose().catch((cause: unknown) =>
              console.error("Recording response cleanup failed", cause),
            );
        },
        file.path,
      ),
    );
    ready = true;
    return { media, metadata: transformed.metadata };
  } catch (cause) {
    cancelled.abort(cause);
    if (cause instanceof MediaCleanupError) {
      output.quarantined = true;
      operation.quarantine();
    }
    await dispose();
    throw cause;
  }
}
