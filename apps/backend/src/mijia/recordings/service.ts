import { createWriteStream } from "node:fs";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { z } from "zod";
import { windowSummarySchema } from "@home-agent/api/contracts";
import {
  mijiaRecordingPlaybackStateSchema,
  type mijiaRecordingPlaybackInputSchema,
} from "@home-agent/api/mijia-recordings";
import type { HouseholdRuntime } from "../../household/runtime";
import type { MijiaService } from "../service";
import { MijiaError } from "../errors";
import {
  readRecordingFile,
  recordingTransferLimits,
} from "../media/recording-file";
import { alignRecordingFrames } from "./alignment";
import { prepareClipDirectory } from "../../media/clip-files";
import {
  createMediaResources,
  MediaCapacityError,
} from "../../media/resources";

const limits = Object.freeze({
  resources: 8,
  cacheBytes: 512 * 1024 * 1024,
  clips: 3,
  retentionMs: 30 * 60_000,
  tombstones: 256,
  readers: 4,
  readMs: 60_000,
  readChunkBytes: 64 * 1024,
  searchMs: 90_000,
});
type PlaybackInput = z.infer<typeof mijiaRecordingPlaybackInputSchema>;
type PlaybackState = z.infer<typeof mijiaRecordingPlaybackStateSchema>;
type UnavailableReason = Extract<
  PlaybackState,
  { state: "unavailable" }
>["reason"];
type WindowSummary = z.infer<typeof windowSummarySchema>;

export class RecordingResourceError extends Error {
  constructor(
    readonly reason:
      | "not_found"
      | "not_ready"
      | "unavailable"
      | "conflict"
      | "capacity",
  ) {
    super(`Recording resource ${reason}`);
  }
}
class RecordingGenerationError extends Error {
  constructor(readonly reason: UnavailableReason) {
    super(`Recording generation ${reason}`);
  }
}
class RecordingResource {
  view: PlaybackState;
  readonly media;
  stopAccess: (() => void) | undefined;
  constructor(
    readonly input: PlaybackInput,
    readonly source: ReturnType<MijiaService["recordingAccess"]>,
    readonly window: WindowSummary | undefined,
    resources: ReturnType<typeof createMediaResources>,
  ) {
    this.view = {
      id: input.id,
      source: "sd_card",
      deviceId: input.deviceId,
      channel: input.channel,
      expiresAt: Date.now() + limits.retentionMs,
      state: "preparing",
    };
    this.media = resources.create(this.view.expiresAt, (reason) => {
      if (this.view.state !== "expired" && this.view.state !== "revoked") {
        this.view =
          reason === "cancelled"
            ? {
                ...resourceBase(this),
                state: "unavailable",
                reason: "cancelled",
              }
            : {
                ...resourceBase(this),
                state: reason === "evicted" ? "expired" : reason,
              };
      }
      this.stopAccess?.();
      this.stopAccess = undefined;
    });
  }
}
function resourceBase(item: RecordingResource) {
  const { id, source, deviceId, channel, expiresAt } = item.view;
  return { id, source, deviceId, channel, expiresAt };
}
function requestKey(input: PlaybackInput) {
  return JSON.stringify([
    input.scope_epoch,
    input.revision,
    input.deviceId,
    input.channel,
    input.selection.kind,
    input.selection.kind === "clip"
      ? input.selection.startAt
      : input.selection.windowId,
  ]);
}

export function createRecordingService(options: {
  household: HouseholdRuntime;
  mijia: MijiaService;
  shutdown: AbortSignal;
  resolveWindow?: (id: string) => WindowSummary | undefined;
  executable?: string;
  directory?: string;
}) {
  const executable = options.executable ?? "ffmpeg";
  const resources = new Map<string, RecordingResource>();
  const tombstones = new Map<string, number>();
  const media = createMediaResources({
    bytes: limits.cacheBytes,
    concurrency: 1,
    readers: limits.readers,
    readMs: limits.readMs,
    readChunkBytes: limits.readChunkBytes,
    eviction: "last_used",
    interruptExpiredReads: true,
  });
  let closing: Promise<void> | undefined;
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
  function assertScope(input: PlaybackInput) {
    if (
      media.snapshot.closed ||
      options.shutdown.aborted ||
      !options.household.ready ||
      options.household.epoch !== input.scope_epoch
    )
      throw new MijiaError("stale_session");
  }
  function current(item: RecordingResource) {
    try {
      assertScope(item.input);
      item.source.signal.throwIfAborted();
      item.source.assertCurrent();
      return true;
    } catch {
      media.invalidate(item.media, "revoked");
      return false;
    }
  }
  function assertCurrent(item: RecordingResource) {
    if (!current(item)) throw new MijiaError("stale_session");
  }
  function prune() {
    const now = Date.now();
    for (const [id, until] of tombstones)
      if (until <= now) tombstones.delete(id);
    media.prune();
  }
  function find(id: string) {
    const item = resources.get(id);
    if (!item) throw new RecordingResourceError("not_found");
    assertCurrent(item);
    media.touch(item.media);
    return item;
  }
  function state(id: string) {
    return mijiaRecordingPlaybackStateSchema.parse(find(id).view);
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
    const index = await options.mijia.readRecordings(
      item.input.revision,
      item.input.deviceId,
      item.input.channel,
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
    // Host receipt time only narrows the search. It never confirms a file/frame mapping.
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
    return nearby.slice(first, first + limits.clips);
  }
  async function download(
    item: RecordingResource,
    startAt: number,
    path: string,
    signal: AbortSignal,
  ) {
    assertCurrent(item);
    signal.throwIfAborted();
    const transfer = await readRecordingFile(
      item.source.access,
      startAt,
      AbortSignal.any([item.source.signal, options.shutdown]),
    );
    let received = 0;
    const bounded = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        transfer.signal.throwIfAborted();
        assertCurrent(item);
        received += chunk.byteLength;
        if (
          received > recordingTransferLimits.bytes ||
          received > transfer.declaredBytes
        )
          throw new RecordingGenerationError("capacity_exceeded");
        // A user release stops storage, but the unnumbered physical reply must
        // finish before the queue can admit another recording on this connection.
        if (!signal.aborted) controller.enqueue(chunk);
      },
    });
    const output = createWriteStream(path, {
      flags: "wx",
      mode: 0o600,
      signal: transfer.signal,
      highWaterMark: limits.readChunkBytes,
    });
    const nativeClosed = new Promise<void>((resolveClosed) => {
      output.once("close", resolveClosed);
    });
    try {
      // The native pipeline owns backpressure, errors and cancellation. Keep
      // the generation slot until the automatically owned descriptor closes.
      await pipeline(
        Readable.fromWeb(transfer.stream.pipeThrough(bounded)),
        output,
        { signal: transfer.signal },
      );
      transfer.signal.throwIfAborted();
      assertCurrent(item);
      if (received !== transfer.declaredBytes)
        throw new RecordingGenerationError("download_failed");
      signal.throwIfAborted();
    } finally {
      output.destroy();
      await nativeClosed;
    }
  }
  function generate(item: RecordingResource) {
    let failure: UnavailableReason = "download_failed";
    const signal = AbortSignal.any([
      item.media.generation.signal,
      item.source.signal,
      options.shutdown,
    ]);
    media.schedule(item.media, {
      reservation: (limits.clips + 1) * recordingTransferLimits.bytes,
      signal,
      generate: async () => {
        assertCurrent(item);
        signal.throwIfAborted();
        const clips = await candidates(item, signal);
        const tools = (mediaTools ??= await import("./media"));
        if (!root) root = prepareRoot();
        const parent = await root;
        signal.throwIfAborted();
        const directory = await mkdtemp(join(parent, "playback-"));
        media.claim(item.media, directory, true);
        await chmod(directory, 0o700);
        signal.throwIfAborted();
        const recorded = [];
        for (const [index, clip] of clips.entries()) {
          const path = join(directory, `segment-${index}.mp4`);
          failure = "download_failed";
          await download(item, clip.startAt, path, signal);
          failure = "invalid_media";
          const metadata = await tools.inspectRecording(path, signal);
          const matchingDimensions = item.window?.frames.some(
            (frame) =>
              frame.fingerprint?.width === metadata.width &&
              frame.fingerprint.height === metadata.height,
          );
          const frames = matchingDimensions
            ? await tools.fingerprintRecording(
                path,
                metadata,
                executable,
                signal,
              )
            : [];
          recorded.push({ clip, path, media: metadata, frames });
        }
        let position = 0;
        const alignment = item.window
          ? alignRecordingFrames(
              item.window,
              recorded.map((candidate) => {
                const mediaStartMs = position;
                position += candidate.media.actualDurationMs;
                return {
                  startAt: candidate.clip.startAt,
                  mediaStartMs,
                  frames: candidate.frames,
                };
              }),
            )
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
                Math.max(a.clip.startAt - target, target - a.clip.endAt, 0) -
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
          if (!boundary) throw new RecordingGenerationError("invalid_media");
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
          ...resourceBase(item),
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
                    ...eventFrameOffsets.map((frame) => frame.uncertaintyMs),
                  ),
                }
              : alignment,
          eventFrameOffsets,
        });
        for (const candidate of recorded)
          await rm(candidate.path, { force: true });
        signal.throwIfAborted();
        assertCurrent(item);
        media.publish(item.media, output, outputSize);
        item.view = view;
      },
      failed: (cause) => {
        if (!item.media.retired) {
          item.view = {
            ...resourceBase(item),
            state: "unavailable",
            reason: signal.aborted
              ? "cancelled"
              : cause instanceof MediaCapacityError
                ? "capacity_exceeded"
                : cause instanceof RecordingGenerationError
                  ? cause.reason
                  : failure,
          };
        }
      },
    });
  }

  const unsubscribe = options.household.subscribe(() => {
    for (const item of resources.values()) current(item);
  });
  function request(input: PlaybackInput) {
    prune();
    assertScope(input);
    if (media.snapshot.error) throw new RecordingResourceError("unavailable");
    if (tombstones.has(input.id)) throw new RecordingResourceError("conflict");
    const existing = resources.get(input.id);
    if (existing) {
      if (requestKey(existing.input) !== requestKey(input))
        throw new RecordingResourceError("conflict");
      return state(existing.input.id);
    }
    for (const [id, candidate] of resources) {
      if (
        candidate.view.state !== "preparing" &&
        candidate.view.state !== "ready" &&
        !candidate.media.ownedPath &&
        !candidate.media.pending &&
        !candidate.media.reads.size
      ) {
        if (tombstones.size >= limits.tombstones - limits.resources) break;
        tombstones.set(id, candidate.view.expiresAt);
        media.invalidate(candidate.media, "expired");
        resources.delete(id);
      }
    }
    if (
      resources.size >= limits.resources ||
      tombstones.size + resources.size >= limits.tombstones
    )
      throw new RecordingResourceError("capacity");
    const source = options.mijia.recordingAccess(
      input.revision,
      input.deviceId,
      input.channel,
    );
    source.signal.throwIfAborted();
    let summary: WindowSummary | undefined;
    if (input.selection.kind === "window") {
      const found = options.resolveWindow?.(input.selection.windowId);
      if (
        !found ||
        found.id !== input.selection.windowId ||
        found.inputState === "revoked" ||
        found.summaryUntil <= Date.now() ||
        found.run.scopeEpoch !== input.scope_epoch ||
        found.run.deviceId !== input.deviceId ||
        found.run.channel !== input.channel
      )
        throw new RecordingResourceError("not_found");
      summary = windowSummarySchema.parse(found);
    }
    const item = new RecordingResource(
      structuredClone(input),
      source,
      summary,
      media,
    );
    resources.set(input.id, item);
    const revoke = () => {
      media.invalidate(item.media, "revoked");
    };
    source.signal.addEventListener("abort", revoke, { once: true });
    item.stopAccess = () => {
      source.signal.removeEventListener("abort", revoke);
    };
    generate(item);
    return state(input.id);
  }
  async function release(id: string) {
    prune();
    const item = resources.get(id);
    if (
      !item &&
      !tombstones.has(id) &&
      tombstones.size + resources.size >= limits.tombstones
    )
      throw new RecordingResourceError("capacity");
    tombstones.set(id, Date.now() + limits.retentionMs);
    if (item) await media.retire(item.media, "cancelled");
  }
  function mediaInfo(id: string) {
    const item = find(id);
    if (
      item.view.state !== "ready" ||
      !item.media.path ||
      item.media.access.signal.aborted
    )
      throw new RecordingResourceError("not_ready");
    return { bytes: item.media.bytes, etag: `"${item.input.id}"` };
  }
  function read(
    id: string,
    range: { start: number; end: number },
    requestSignal: AbortSignal,
  ) {
    const item = find(id);
    mediaInfo(id);
    if (media.snapshot.reads >= limits.readers)
      throw new RecordingResourceError("capacity");
    if (
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 0 ||
      range.end < range.start ||
      range.end >= item.media.bytes
    )
      throw new RecordingResourceError("unavailable");
    const signal = AbortSignal.any([
      requestSignal,
      options.shutdown,
      item.source.signal,
    ]);
    signal.throwIfAborted();
    return media.read(item.media, signal, range);
  }
  function close() {
    if (closing) return closing;
    unsubscribe();
    options.shutdown.removeEventListener("abort", onShutdown);
    closing = (async () => {
      await media.close();
      if (root) await rm(await root, { recursive: true, force: true });
      resources.clear();
      tombstones.clear();
    })();
    return closing;
  }
  function onShutdown() {
    close().catch((cause: unknown) => {
      console.error("Recording shutdown failed", cause);
    });
  }
  options.shutdown.addEventListener("abort", onShutdown, { once: true });
  if (options.shutdown.aborted) onShutdown();
  return { request, state, release, mediaInfo, read, close };
}
