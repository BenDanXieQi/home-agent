import { createPlaybackGenerator } from "./playback";
import type { z } from "zod";
import { windowSummarySchema } from "@home-agent/api/contracts";
import {
  mijiaRecordingPlaybackStateSchema,
  type mijiaRecordingPlaybackInputSchema,
  type mijiaRecordingAvailabilityQuerySchema,
} from "@home-agent/api/mijia-recordings";
import type { HouseholdRuntime } from "../../household/runtime";
import type { MijiaService } from "../service";
import { MijiaError } from "../errors";
import type { createSdRecordingSource } from "./source";
import type { createRecordingsService } from "../../recordings/service";
import { createMediaResources } from "../../media/resources";

const limits = Object.freeze({
  cacheBytes: 512 * 1024 * 1024,
  retentionMs: 30 * 60_000,
  readMs: 60_000,
  readChunkBytes: 64 * 1024,
});
type PlaybackInput = z.infer<typeof mijiaRecordingPlaybackInputSchema>;
type PlaybackState = z.infer<typeof mijiaRecordingPlaybackStateSchema>;
type WindowSummary = z.infer<typeof windowSummarySchema>;

export class RecordingResourceError extends Error {
  constructor(
    readonly reason: "not_found" | "not_ready" | "unavailable" | "conflict",
  ) {
    super(`Recording resource ${reason}`);
  }
}
export class RecordingResource {
  base() {
    const { id, source, deviceId, channel, expiresAt } = this.view;
    return { id, source, deviceId, channel, expiresAt };
  }
  view: PlaybackState;
  readonly media;
  stopAccess: (() => void) | undefined;
  constructor(
    readonly input: PlaybackInput,
    readonly source: ReturnType<MijiaService["recordingAccess"]>,
    public window: WindowSummary | undefined,
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
                ...this.base(),
                state: "unavailable",
                reason: "cancelled",
              }
            : {
                ...this.base(),
                state: reason === "evicted" ? "expired" : reason,
              };
      }
      this.stopAccess?.();
      this.stopAccess = undefined;
    });
  }
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
  household: Pick<HouseholdRuntime, "ready" | "epoch" | "subscribe">;
  sd: ReturnType<typeof createSdRecordingSource>;
  originals: Pick<ReturnType<typeof createRecordingsService>, "beginRead">;
  shutdown: AbortSignal;
  resolveWindow?: (
    id: string,
    signal?: AbortSignal,
  ) => WindowSummary | undefined | Promise<WindowSummary | undefined>;
  executable?: string;
  directory?: string;
}) {
  const sd = options.sd;
  const resources = new Map<string, RecordingResource>();
  const tombstones = new Map<string, number>();
  const media = createMediaResources({
    bytes: limits.cacheBytes,
    readMs: limits.readMs,
    readChunkBytes: limits.readChunkBytes,
    eviction: "last_used",
    interruptExpiredReads: true,
  });
  let closing: Promise<void> | undefined;
  const generation = createPlaybackGenerator({
    ...options,
    media,
    current,
    assertCurrent,
  });

  function assertScope(input: Pick<PlaybackInput, "scope_epoch">) {
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

  const unsubscribe = options.household.subscribe(() => {
    for (const item of resources.values()) current(item);
  });
  async function availability(
    input: z.infer<typeof mijiaRecordingAvailabilityQuerySchema>,
    requestSignal: AbortSignal,
  ) {
    assertScope(input);
    const source = sd.access(input.revision, input.deviceId, input.channel);
    const signal = AbortSignal.any([
      requestSignal,
      source.signal,
      options.shutdown,
    ]);
    const matches = [];
    let index: Awaited<ReturnType<MijiaService["readRecordings"]>> | undefined;
    for (const at of [...new Set(input.at)].toSorted((a, b) => a - b)) {
      signal.throwIfAborted();
      if (
        !index ||
        (index.status === "ready" &&
          index.nextAfterMs !== null &&
          at > index.nextAfterMs)
      ) {
        index = await sd.index(
          input,
          { afterMs: Math.max(0, at - 255_001), limit: 1000 },
          signal,
        );
        assertScope(input);
        source.assertCurrent();
      }
      if (index.status !== "ready")
        return { status: index.status, reason: index.reason };
      matches.push({
        at,
        clip:
          index.recordings.find(
            (clip) => clip.startAt <= at && at < clip.endAt,
          ) ?? null,
      });
    }
    return { status: "ready" as const, matches };
  }
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
        tombstones.set(id, candidate.view.expiresAt);
        media.invalidate(candidate.media, "expired");
        resources.delete(id);
      }
    }
    const source = sd.access(input.revision, input.deviceId, input.channel);
    source.signal.throwIfAborted();
    const item = new RecordingResource(
      structuredClone(input),
      source,
      undefined,
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
    generation.generate(item).catch((cause: unknown) => {
      console.error("Recording generation failed", cause);
    });
    return state(input.id);
  }
  async function release(id: string) {
    prune();
    const item = resources.get(id);
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
      await generation.close();
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
  return { availability, request, state, release, mediaInfo, read, close };
}
