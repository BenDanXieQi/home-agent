import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import PQueue from "p-queue";

export class MediaCapacityError extends Error {}
export class MediaCleanupError extends Error {}

type Retirement = "expired" | "evicted" | "revoked" | "cancelled";

function resource(expiresAt: number, onRetire: (reason: Retirement) => void) {
  return {
    expiresAt,
    expiresMono: performance.now() + Math.max(0, expiresAt - Date.now()),
    lastUsed: performance.now(),
    onRetire,
    generation: new AbortController(),
    access: new AbortController(),
    reads: new Set<Promise<void>>(),
    path: undefined as string | undefined,
    ownedPath: undefined as string | undefined,
    recursive: false,
    bytes: 0,
    reserved: 0,
    retired: false,
    quarantined: false,
    pending: undefined as Promise<void> | undefined,
    removing: undefined as Promise<void> | undefined,
    retirement: undefined as Promise<void> | undefined,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  };
}

export function mediaExpired(item: ReturnType<typeof resource>) {
  return Date.now() >= item.expiresAt || performance.now() >= item.expiresMono;
}

// Each media domain owns an instance: slow SD transfers cannot occupy window slots.
export function createMediaResources(options: {
  bytes: number;
  concurrency: number;
  readers: number;
  readMs: number;
  readChunkBytes: number;
  eviction: "expiry" | "last_used";
  interruptExpiredReads: boolean;
}) {
  const items = new Set<ReturnType<typeof resource>>();
  const queue = new PQueue({ concurrency: options.concurrency });
  let reads = 0,
    bytes = 0,
    reservedBytes = 0,
    closed = false;
  let failure: Error | undefined;
  let closing: Promise<void> | undefined;

  function storageFailed(cause: unknown) {
    failure ??=
      cause instanceof Error
        ? cause
        : new Error("Media cleanup failed", { cause });
    console.error("Media resource cleanup failed", cause);
  }
  function cleanup(item: ReturnType<typeof resource>) {
    if (item.removing) return item.removing;
    item.removing = (async () => {
      if (item.quarantined)
        throw new MediaCleanupError("Media exit or cleanup unconfirmed");
      await Promise.all(item.reads);
      if (item.ownedPath)
        await rm(item.ownedPath, { recursive: item.recursive, force: true });
      bytes -= item.bytes;
      reservedBytes -= item.reserved;
      item.bytes = item.reserved = 0;
      item.path = item.ownedPath = undefined;
      if (item.retired) {
        clearTimeout(item.timer);
        items.delete(item);
      }
    })().finally(() => {
      item.removing = undefined;
    });
    return item.removing;
  }
  function retire(item: ReturnType<typeof resource>, reason: Retirement) {
    if (!item.retired || reason === "revoked") item.onRetire(reason);
    item.retired = true;
    clearTimeout(item.timer);
    item.generation.abort(new Error(`Media ${reason}`));
    if (
      reason === "revoked" ||
      reason === "cancelled" ||
      options.interruptExpiredReads
    )
      item.access.abort(new Error(`Media ${reason}`));
    if (!item.retirement) {
      item.retirement = (async () => {
        await item.pending;
        await cleanup(item);
      })();
      item.retirement.catch(storageFailed);
    }
    return item.retirement;
  }
  async function reserve(item: ReturnType<typeof resource>, size: number) {
    if (bytes + reservedBytes + size > options.bytes) {
      const candidates = [...items]
        .filter((other) => other !== item && other.path && !other.retired)
        .toSorted((a, b) =>
          options.eviction === "expiry"
            ? a.expiresAt - b.expiresAt
            : a.lastUsed - b.lastUsed,
        );
      for (const candidate of candidates) {
        if (bytes + reservedBytes + size <= options.bytes) break;
        // Earlier deletions yield to new readers and other retirements.
        if (
          candidate.retired ||
          !candidate.path ||
          candidate.pending ||
          candidate.reads.size
        )
          continue;
        await retire(candidate, "evicted");
      }
    }
    if (bytes + reservedBytes + size > options.bytes)
      throw new MediaCapacityError("Media disk capacity exhausted");
    reservedBytes += size;
    item.reserved = size;
  }
  function invalidate(item: ReturnType<typeof resource>, reason: Retirement) {
    // The resource retains retirement and records rejection for close().
    // oxlint-disable-next-line typescript/no-floating-promises
    retire(item, reason);
  }
  return {
    create(expiresAt: number, onRetire: (reason: Retirement) => void) {
      if (closed) throw new Error("Media resources closed");
      const item = resource(expiresAt, onRetire);
      items.add(item);
      item.timer = setTimeout(
        () => {
          invalidate(item, "expired");
        },
        Math.max(0, expiresAt - Date.now()),
      );
      item.timer.unref();
      return item;
    },
    claim(item: ReturnType<typeof resource>, path: string, recursive = false) {
      if (item.ownedPath) throw new Error("Media storage already owned");
      item.ownedPath = path;
      item.recursive = recursive;
    },
    publish(item: ReturnType<typeof resource>, path: string, size: number) {
      item.generation.signal.throwIfAborted();
      if (
        !item.ownedPath ||
        item.path ||
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        size > item.reserved
      )
        throw new MediaCapacityError("Invalid media product size or ownership");
      item.path = path;
      item.bytes = size;
      bytes += size;
    },
    schedule(
      item: ReturnType<typeof resource>,
      input: {
        reservation: number;
        signal: AbortSignal;
        generate: () => Promise<void>;
        failed: (cause: unknown) => void;
      },
    ) {
      if (closed || item.pending) throw new Error("Media task unavailable");
      // Only queued work is cancellable by PQueue. Once started, the native
      // operation owns cancellation and must keep its slot through cleanup.
      const waiting = new AbortController();
      const signal = AbortSignal.any([input.signal, item.generation.signal]);
      const cancelWaiting = () => waiting.abort(signal.reason);
      signal.addEventListener("abort", cancelWaiting, { once: true });
      if (signal.aborted) cancelWaiting();
      item.pending = queue
        .add(
          async () => {
            signal.removeEventListener("abort", cancelWaiting);
            // Register ownership before generation can trigger retirement.
            await Promise.resolve();
            let succeeded = false;
            try {
              signal.throwIfAborted();
              if (failure) throw failure;
              await reserve(item, input.reservation);
              signal.throwIfAborted();
              await input.generate();
              signal.throwIfAborted();
              succeeded = !!item.path && !item.retired;
            } catch (cause) {
              if (cause instanceof MediaCleanupError) {
                item.quarantined = true;
                storageFailed(cause);
              }
              input.failed(cause);
            } finally {
              if (succeeded) {
                reservedBytes -= item.reserved;
                item.reserved = 0;
              } else await cleanup(item);
            }
          },
          { signal: waiting.signal },
        )
        .catch(async (cause: unknown) => {
          if (!waiting.signal.aborted) throw cause;
          input.failed(cause);
          await cleanup(item);
        })
        .finally(() => {
          signal.removeEventListener("abort", cancelWaiting);
          item.pending = undefined;
        });
      item.pending.catch(storageFailed);
    },
    retire,
    invalidate,
    prune() {
      for (const item of items)
        if (mediaExpired(item)) invalidate(item, "expired");
    },
    touch(item: ReturnType<typeof resource>) {
      item.lastUsed = performance.now();
      if (mediaExpired(item)) invalidate(item, "expired");
    },
    read(
      item: ReturnType<typeof resource>,
      signal: AbortSignal,
      range?: { start: number; end: number },
      onClose?: () => void,
    ) {
      if (closed || item.retired || !item.path || mediaExpired(item))
        throw new Error("Media product unavailable");
      if (reads >= options.readers)
        throw new MediaCapacityError("Media read capacity exhausted");
      const scoped = AbortSignal.any([
        signal,
        item.access.signal,
        AbortSignal.timeout(options.readMs),
      ]);
      scoped.throwIfAborted();
      const stream = createReadStream(item.path, {
        ...range,
        signal: scoped,
        highWaterMark: options.readChunkBytes,
      });
      const finished = new Promise<void>((resolve) => {
        stream.once("close", () => {
          reads--;
          item.reads.delete(finished);
          onClose?.();
          resolve();
        });
      });
      reads++;
      item.reads.add(finished);
      return Readable.toWeb(stream);
    },
    get snapshot() {
      return {
        bytes,
        reservedBytes,
        reads,
        queued: queue.size,
        encoding: queue.pending,
        closed,
        error: failure ? failure.message.slice(0, 1024) : null,
      };
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        const results = await Promise.allSettled(
          [...items].map((item) => retire(item, "revoked")),
        );
        await queue.onIdle();
        await Promise.all([...items].flatMap((item) => [...item.reads]));
        if (failure || results.some((result) => result.status === "rejected"))
          throw new MediaCleanupError("Media resource shutdown failed", {
            cause: failure,
          });
      })();
      return closing;
    },
  };
}
