import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { windowSummarySchema } from "@home-agent/api/contracts";
import { mijiaRecordingPlaybackStateSchema } from "@home-agent/api/mijia-recordings";
import { recordingTransferLimits } from "../media/recording-file";
import { SdRecordingSourceError } from "./source";
import { alignRecordingFrames } from "./alignment";
import { prepareClipDirectory } from "../../media/clip-files";
import {
  MediaCapacityError,
  MediaCleanupError,
  type createMediaResources,
} from "../../media/resources";
import type { createRecordingService, RecordingResource } from "./service";

type UnavailableReason = Extract<
  RecordingResource["view"],
  { state: "unavailable" }
>["reason"];
class RecordingGenerationError extends Error {
  constructor(readonly reason: UnavailableReason) {
    super(`Recording generation ${reason}`);
  }
}
const limits = { clips: 3, searchMs: 90_000 };

export function createPlaybackGenerator(
  options: Pick<
    Parameters<typeof createRecordingService>[0],
    | "sd"
    | "originals"
    | "shutdown"
    | "resolveWindow"
    | "executable"
    | "directory"
  > & {
    media: ReturnType<typeof createMediaResources>;
    assertCurrent: (item: RecordingResource) => void;
    current: (item: RecordingResource) => boolean;
  },
) {
  const executable = options.executable ?? "ffmpeg";
  const { sd, media, assertCurrent, current } = options;
  let root: ReturnType<typeof prepareRoot> | undefined;
  let mediaTools: typeof import("./media") | undefined;
  async function prepareRoot() {
    const parent = resolvePath(
      options.directory ?? join(tmpdir(), "home-agent-recordings"),
    );
    await prepareClipDirectory(parent);
    const directory = await mkdtemp(join(parent, "instance-"));
    await chmod(directory, 0o700);
    return directory;
  }
  async function candidates(item: RecordingResource, signal: AbortSignal) {
    const { selection } = item.input;
    const target =
      selection.kind === "clip" ? selection.startAt : item.window!.startedAt;
    const afterMs = Math.max(
      0,
      Math.floor(
        selection.kind === "clip"
          ? target - 1
          : target - limits.searchMs - 255_000 - 1,
      ),
    );
    const index = await sd.index(
      item.input,
      { afterMs, limit: selection.kind === "clip" ? 1 : 1000 },
      signal,
    );
    assertCurrent(item);
    signal.throwIfAborted();
    if (index.status !== "ready")
      throw new RecordingGenerationError(
        index.reason === "unsupported_source"
          ? "unsupported_source"
          : "source_unavailable",
      );
    if (selection.kind === "clip") {
      const clip = index.recordings.find(
        (candidate) => candidate.startAt === selection.startAt,
      );
      if (!clip || clip.startAt % 1000 !== 0)
        throw new RecordingGenerationError("recording_missing");
      return [clip];
    }
    const nearby = index.recordings.filter(
      (clip) =>
        clip.endAt >= target - limits.searchMs &&
        clip.startAt <= item.window!.endedAt + limits.searchMs,
    );
    if (!nearby.length)
      throw new RecordingGenerationError("no_matching_recording");
    let nearest = 0;
    const distance = (clip: (typeof nearby)[number]) =>
      Math.max(clip.startAt - target, target - clip.endAt, 0);
    for (let position = 1; position < nearby.length; position++)
      if (distance(nearby[position]!) < distance(nearby[nearest]!))
        nearest = position;
    if (item.window!.frames.filter((frame) => frame.fingerprint).length < 2)
      return [nearby[nearest]!];
    const first = Math.max(
      0,
      Math.min(nearest - 1, nearby.length - limits.clips),
    );
    return nearby
      .slice(first, first + limits.clips)
      .toSorted((a, b) => distance(a) - distance(b));
  }
  function generate(item: RecordingResource) {
    let failure: UnavailableReason = "download_failed";
    const signal = AbortSignal.any([
      item.media.generation.signal,
      item.source.signal,
      options.shutdown,
    ]);
    return media
      .execute(item.media, {
        reservation: recordingTransferLimits.bytes,
        signal,
        generate: async () => {
          let originals:
            | Awaited<ReturnType<typeof options.originals.beginRead>>
            | undefined;
          try {
            assertCurrent(item);
            signal.throwIfAborted();
            const input = item.input;
            if (input.selection.kind === "window") {
              failure = "window_read_failed";
              const found = await options.resolveWindow?.(
                input.selection.windowId,
                signal,
              );
              if (
                !found ||
                found.id !== input.selection.windowId ||
                found.inputState === "revoked" ||
                found.summaryUntil <= Date.now() ||
                found.run.deviceId !== input.deviceId ||
                found.run.channel !== input.channel
              )
                throw new RecordingGenerationError("window_unavailable");
              item.window = windowSummarySchema.parse(found);
            }
            assertCurrent(item);
            signal.throwIfAborted();
            failure = "source_unavailable";
            const clips = await candidates(item, signal);
            originals = await options.originals.beginRead({
              signal,
              cancel: (reason) => {
                item.media.generation.abort(
                  reason ?? new Error("Recording read cancelled"),
                );
              },
            });
            failure = "download_failed";
            const tools = (mediaTools ??= await import("./media"));
            root ??= prepareRoot().catch((cause: unknown) => {
              root = undefined;
              throw cause;
            });
            const parent = await root;
            signal.throwIfAborted();
            const directory = await mkdtemp(join(parent, "playback-"));
            media.claim(item.media, directory, true);
            await chmod(directory, 0o700);
            signal.throwIfAborted();
            const recorded = [];
            let completeCandidates = true;
            for (const clip of clips) {
              try {
                failure = "download_failed";
                const original = await originals.borrowSd(
                  { ...item.input, startAt: clip.startAt },
                  item.source,
                );
                const { path, media: metadata } = original;
                failure = "invalid_media";
                const matchingDimensions = item.window?.frames.some(
                  (frame) =>
                    frame.fingerprint?.width === metadata.width &&
                    frame.fingerprint.height === metadata.height,
                );
                let frames: Awaited<
                  ReturnType<typeof tools.fingerprintRecording>
                > = [];
                if (matchingDimensions) {
                  try {
                    frames = await tools.fingerprintRecording(
                      path,
                      metadata,
                      executable,
                      signal,
                    );
                  } catch (cause) {
                    if (cause instanceof MediaCleanupError) throw cause;
                    signal.throwIfAborted();
                    assertCurrent(item);
                    completeCandidates = false;
                  }
                }
                recorded.push({ clip, path, media: metadata, frames });
              } catch (cause) {
                if (cause instanceof MediaCleanupError) throw cause;
                signal.throwIfAborted();
                assertCurrent(item);
                if (item.input.selection.kind === "clip") throw cause;
                completeCandidates = false;
              }
            }
            if (!recorded.length) throw new RecordingGenerationError(failure);
            recorded.sort((a, b) => a.clip.startAt - b.clip.startAt);
            let position = 0;
            const alignment = item.window
              ? completeCandidates
                ? alignRecordingFrames(
                    item.window,
                    recorded.map((candidate) => {
                      const mediaStartMs = position;
                      position += candidate.media.actualDurationMs;
                      return {
                        startAt: candidate.clip.startAt,
                        mediaStartMs,
                        width: candidate.media.width,
                        height: candidate.media.height,
                        frames: candidate.frames,
                      };
                    }),
                  )
                : {
                    type: "unknown" as const,
                    reason: "no_frame_mapping" as const,
                  }
              : { type: "unknown" as const, reason: "clip_selected" as const };
            let selected = recorded;
            if (alignment.type === "confirmed") {
              const starts = new Set(
                alignment.matches.map((match) => match.startAt),
              );
              const indices = recorded.flatMap((candidate, index) =>
                starts.has(candidate.clip.startAt) ? [index] : [],
              );
              selected = recorded.slice(
                Math.min(...indices),
                Math.max(...indices) + 1,
              );
            } else if (recorded.length > 1) {
              const target = item.window!.startedAt;
              selected = [
                [...recorded].toSorted(
                  (a, b) =>
                    Math.max(
                      a.clip.startAt - target,
                      target - a.clip.endAt,
                      0,
                    ) -
                    Math.max(b.clip.startAt - target, target - b.clip.endAt, 0),
                )[0]!,
              ];
            }
            failure = "invalid_media";
            const output = join(directory, "playback.mp4");
            const encoded = await tools.encodeRecording(
              selected.map((candidate) => ({
                path: candidate.path,
                media: candidate.media,
              })),
              output,
              executable,
              signal,
            );
            signal.throwIfAborted();
            assertCurrent(item);
            const outputSize = (await stat(output)).size;
            if (outputSize <= 0 || outputSize > recordingTransferLimits.bytes)
              throw new RecordingGenerationError("capacity_exceeded");
            await chmod(output, 0o600);
            const segments = selected.map((candidate, index) => {
              const boundary = encoded.segmentBoundaries[index];
              if (!boundary)
                throw new RecordingGenerationError("invalid_media");
              const previous = selected[index - 1];
              return {
                startAt: candidate.clip.startAt,
                endAt: Math.round(
                  candidate.clip.startAt + candidate.media.actualDurationMs,
                ),
                mediaStartMs: boundary.mediaStartMs,
                mediaEndMs: boundary.mediaEndMs,
                timestampBasis: "device_recording" as const,
                gapBeforeMs: previous
                  ? Math.max(
                      0,
                      candidate.clip.startAt -
                        previous.clip.startAt -
                        previous.media.actualDurationMs,
                    )
                  : 0,
              };
            });
            const eventFrameOffsets =
              alignment.type === "confirmed"
                ? alignment.matches.map((match) => {
                    const segment = segments.find(
                      (candidate) => candidate.startAt === match.startAt,
                    );
                    if (!segment)
                      throw new RecordingGenerationError("invalid_media");
                    return {
                      sequence: match.sequence,
                      offsetMs: segment.mediaStartMs + match.offsetMs,
                      uncertaintyMs: match.durationMs,
                    };
                  })
                : [];
            const firstMatch = eventFrameOffsets[0];
            const view = mijiaRecordingPlaybackStateSchema.parse({
              ...item.base(),
              state: "ready",
              fileUrl: `/api/mijia/recordings/playback/${item.input.id}/media`,
              actualDurationMs: encoded.actualDurationMs,
              segments,
              alignment:
                alignment.type === "confirmed" && firstMatch
                  ? {
                      type: "confirmed",
                      basis: "frame_offset",
                      seekOffsetMs: firstMatch.offsetMs,
                      uncertaintyMs: Math.max(
                        ...eventFrameOffsets.map(
                          (frame) => frame.uncertaintyMs,
                        ),
                      ),
                    }
                  : alignment,
              eventFrameOffsets,
            });
            signal.throwIfAborted();
            assertCurrent(item);
            await media.publish(item.media, output, outputSize);
            item.view = view;
          } finally {
            await originals?.release();
          }
        },
      })
      .catch((cause: unknown) => {
        if (!item.media.retired && current(item)) {
          item.view = {
            ...item.base(),
            state: "unavailable",
            reason:
              cause instanceof MediaCapacityError ||
              signal.reason instanceof MediaCapacityError
                ? "capacity_exceeded"
                : signal.aborted
                  ? "cancelled"
                  : cause instanceof RecordingGenerationError ||
                      cause instanceof SdRecordingSourceError
                    ? cause.reason
                    : failure,
          };
        }
        if (cause instanceof MediaCleanupError)
          console.error("Recording generation cleanup failed", cause);
      });
  }

  async function close() {
    if (root) await rm(await root, { recursive: true, force: true });
  }
  return { generate, close };
}
