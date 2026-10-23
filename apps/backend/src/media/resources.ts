import {
  createMediaResource,
  mediaExpired,
  type MediaResource,
} from "./resource";
import { storageBytes } from "./clip-files";
type Retirement = Parameters<MediaResource["onRetire"]>[0];
import { callbackify } from "node:util";
import { addAbortSignal, Writable } from "node:stream";
import { readMediaFile } from "./file-reader";
import { open, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import pTimeout from "p-timeout";

export class MediaCapacityError extends Error {}
export class MediaCleanupError extends Error {}

const cleanupMs = 3000;

export function createMediaResources(options: {
  bytes: number;
  readMs: number;
  readChunkBytes: number;
  readTimeout?: "total" | "idle";
  eviction: "expiry" | "last_used" | "oldest";
  interruptExpiredReads: boolean;
}) {
  const items = new Set<MediaResource>();
  let reads = 0,
    bytes = 0,
    reservedBytes = 0,
    closed = false;
  let failure: Error | undefined;
  let closing: Promise<void> | undefined;
  let capacity = Promise.resolve();

  function serialized<T>(operation: () => Promise<T>) {
    const result = capacity.then(operation);
    capacity = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  function storageFailed(cause: unknown) {
    if (failure) return;
    failure =
      cause instanceof Error
        ? cause
        : new Error("Media cleanup failed", { cause });
    console.error("Media resource cleanup failed", cause);
  }
  function released<T>(
    item: MediaResource,
    operation: Promise<T>,
    milliseconds = cleanupMs,
  ) {
    return pTimeout(operation, {
      milliseconds,
      message: new MediaCleanupError("Media release unconfirmed"),
    }).catch((cause: unknown) => {
      const error =
        cause instanceof MediaCleanupError
          ? cause
          : new MediaCleanupError("Media release failed", { cause });
      item.quarantined = true;
      item.generation.abort(error);
      item.access.abort(error);
      storageFailed(error);
      throw error;
    });
  }
  async function removeFiles(item: MediaResource) {
    if (item.quarantined)
      throw new MediaCleanupError("Media exit or cleanup unconfirmed");
    if (item.ownedPath)
      await rm(item.ownedPath, { recursive: item.recursive, force: true });
    if (item.quarantined)
      throw new MediaCleanupError("Media cleanup completion unconfirmed");
    bytes -= item.bytes;
    reservedBytes -= item.reserved;
    item.bytes = item.reserved = 0;
    item.path = item.ownedPath = undefined;
    if (item.retired) {
      clearTimeout(item.timer);
      items.delete(item);
    }
  }
  function cleanup(item: MediaResource) {
    if (item.removing) return item.removing;
    item.removing = (async () => {
      if (item.reads.size || item.uses.size)
        await released(
          item,
          Promise.all([...item.reads, ...item.uses]),
          item.retired && !item.access.signal.aborted
            ? options.readMs + cleanupMs
            : cleanupMs,
        );
      await released(
        item,
        serialized(() => removeFiles(item)),
      );
    })().finally(() => {
      item.removing = undefined;
    });
    return item.removing;
  }
  function markRetired(item: MediaResource, reason: Retirement) {
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
  }
  function retire(item: MediaResource, reason: Retirement) {
    markRetired(item, reason);
    if (!item.retirement) {
      item.retirement = (async () => {
        if (item.pending) await released(item, item.pending);
        await cleanup(item);
      })();
      item.retirement.catch(storageFailed);
    }
    return reason === "revoked" || reason === "cancelled"
      ? released(item, item.retirement)
      : item.retirement;
  }
  function hasCapacity(size = 0) {
    return bytes + reservedBytes + size <= options.bytes;
  }
  async function makeRoom(size: number, item?: MediaResource) {
    if (hasCapacity(size)) return true;

    const candidates = [...items]
      .filter((other) => other !== item && other.path && !other.retired)
      .toSorted((a, b) =>
        options.eviction === "expiry"
          ? (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity)
          : options.eviction === "oldest"
            ? a.createdAt - b.createdAt
            : a.lastUsed - b.lastUsed,
      );
    for (const candidate of candidates) {
      if (hasCapacity(size)) break;
      if (
        candidate.retired ||
        !candidate.path ||
        candidate.retirement ||
        candidate.pending ||
        candidate.removing ||
        candidate.reads.size ||
        candidate.uses.size
      )
        continue;
      markRetired(candidate, "evicted");
      candidate.retirement = released(candidate, removeFiles(candidate));
      candidate.retirement.catch(storageFailed);
      await candidate.retirement;
    }
    return hasCapacity(size);
  }
  function reserve(item: MediaResource, size: number) {
    if (!Number.isSafeInteger(size) || size < 0)
      throw new MediaCapacityError("Invalid media reservation size");

    return serialized(async () => {
      if (closed) throw new Error("Media resources closed");
      if (failure) throw failure;
      item.generation.signal.throwIfAborted();
      if (!(await makeRoom(size, item)))
        throw new MediaCapacityError("Media disk capacity exhausted");
      if (failure) throw failure;
      item.generation.signal.throwIfAborted();
      reservedBytes += size;
      item.reserved += size;
    });
  }
  function invalidate(item: MediaResource, reason: Retirement) {
    retire(item, reason).catch(storageFailed);
  }
  return {
    create(expiresAt: number | null, onRetire: (reason: Retirement) => void) {
      if (closed) throw new Error("Media resources closed");
      const item = createMediaResource(expiresAt, onRetire);
      items.add(item);
      if (expiresAt !== null) {
        item.timer = setTimeout(
          () => {
            invalidate(item, "expired");
          },
          Math.max(0, expiresAt - Date.now()),
        );
        item.timer.unref();
      }
      return item;
    },
    claim(item: MediaResource, path: string, recursive = false) {
      if (item.ownedPath) throw new Error("Media storage already owned");
      item.ownedPath = path;
      item.recursive = recursive;
    },
    openWriter(
      item: MediaResource,
      signal: AbortSignal,
      path = item.ownedPath,
    ) {
      if (failure) throw failure;
      if (
        closed ||
        item.retired ||
        !item.ownedPath ||
        !path ||
        (item.recursive
          ? dirname(path) !== item.ownedPath
          : path !== item.ownedPath) ||
        item.path ||
        item.writing
      )
        throw new Error("Media writer unavailable");

      const scoped = AbortSignal.any([signal, item.generation.signal]);
      scoped.throwIfAborted();
      const protection = Promise.withResolvers<void>();
      item.uses.add(protection.promise);
      item.writing = true;
      let file: Awaited<ReturnType<typeof open>> | undefined;
      let writing: Promise<void> | undefined;
      const writer = new Writable({
        highWaterMark: options.readChunkBytes,
        construct: callbackify(async () => {
          file = await open(path, "wx", 0o600);
        }),
        write(chunk: Buffer, _encoding, callback) {
          writing = (async () => {
            scoped.throwIfAborted();
            await reserve(item, Math.max(0, chunk.byteLength - item.reserved));
            scoped.throwIfAborted();
            // A partial write keeps its reservation until file cleanup.
            await file!.writeFile(chunk);

            await serialized(async () => {
              bytes += chunk.byteLength;
              reservedBytes -= chunk.byteLength;
              item.bytes += chunk.byteLength;
              item.reserved -= chunk.byteLength;
            });
          })();
          callbackify(() => writing!)(callback);
        },
        destroy(cause, callback) {
          if (cause) item.generation.abort(cause);
          const nativeClosing = (async () => {
            try {
              if (writing) await Promise.allSettled([writing]);
              await file?.close();
            } catch (error) {
              item.quarantined = true;
              throw error;
            } finally {
              item.writing = false;
              item.uses.delete(protection.promise);
              protection.resolve();
            }
          })();
          callbackify(async () => {
            await released(item, nativeClosing);
            if (cause) throw cause;
          })(callback);
        },
      });
      return addAbortSignal(scoped, writer);
    },

    async publish(item: MediaResource, path: string, size: number) {
      item.generation.signal.throwIfAborted();
      if (
        !item.ownedPath ||
        item.path ||
        item.writing ||
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        size > item.bytes + item.reserved
      )
        throw new MediaCapacityError("Invalid media product size or ownership");
      const totalSize = await storageBytes(item.ownedPath);
      const productSize =
        path === item.ownedPath ? totalSize : (await stat(path)).size;
      await serialized(async () => {
        item.generation.signal.throwIfAborted();
        if (
          item.path ||
          item.writing ||
          productSize !== size ||
          totalSize > item.bytes + item.reserved
        )
          throw new MediaCapacityError("Media file exceeds its allocation");

        const growth = totalSize - item.bytes;
        const covered = Math.max(0, growth);
        bytes += growth;
        reservedBytes -= covered;
        item.bytes = totalSize;
        item.reserved -= covered;
        item.path = path;
      });
    },
    use(item: MediaResource) {
      if (closed || item.retired || mediaExpired(item))
        throw new Error("Media product unavailable");
      const { promise, resolve } = Promise.withResolvers<void>();
      item.uses.add(promise);
      return () => {
        item.uses.delete(promise);
        resolve();
      };
    },
    execute<T>(
      item: MediaResource,
      input: {
        reservation?: number;
        signal: AbortSignal;
        generate: () => Promise<T>;
        failed?: (cause: unknown) => void;
      },
    ) {
      if (closed || item.pending) throw new Error("Media task unavailable");
      const signal = AbortSignal.any([input.signal, item.generation.signal]);
      const operation = (async () => {
        await Promise.resolve();
        let succeeded = false;
        try {
          signal.throwIfAborted();
          if (failure) throw failure;
          await reserve(item, input.reservation ?? 0);
          signal.throwIfAborted();
          const result = await input.generate();
          signal.throwIfAborted();
          succeeded = !!item.path && !item.retired;
          return result;
        } catch (cause) {
          if (cause instanceof MediaCleanupError) {
            item.quarantined = true;
            storageFailed(cause);
          }
          input.failed?.(cause);
          throw cause;
        } finally {
          if (succeeded) {
            await serialized(async () => {
              reservedBytes -= item.reserved;
              item.reserved = 0;
            });
          } else await cleanup(item);
        }
      })().finally(() => {
        item.pending = undefined;
      });
      item.pending = operation.then(
        () => {},
        () => {},
      );
      return operation;
    },
    retire,
    invalidate,
    prune() {
      for (const item of items)
        if (mediaExpired(item)) invalidate(item, "expired");
    },
    touch(item: MediaResource) {
      item.lastUsed = performance.now();
      if (mediaExpired(item)) invalidate(item, "expired");
    },
    read(
      item: MediaResource,
      signal: AbortSignal,
      range?: { start: number; end: number },
      onClose?: () => void,
      path = item.path,
    ) {
      if (closed || item.retired || !item.path || !path || mediaExpired(item))
        throw new Error("Media product unavailable");
      const stream = readMediaFile(
        item,
        path,
        signal,
        options,
        () => {
          reads--;
          onClose?.();
        },
        range,
      );
      reads++;
      return stream;
    },

    get snapshot() {
      return {
        bytes,
        reservedBytes,
        reads,
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
        if (failure || results.some((result) => result.status === "rejected"))
          throw new MediaCleanupError("Media resource shutdown failed", {
            cause: failure,
          });
      })();
      return closing;
    },
  };
}
