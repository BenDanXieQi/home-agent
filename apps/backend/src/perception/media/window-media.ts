import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import PQueue from "p-queue";
import type { z } from "zod";
import type {
  mediaSelectionSchema,
  mediaViewSchema,
  mediaRequestSchema,
  windowSummarySchema,
} from "@home-agent/api/contracts";
import type { createWindowStore } from "../window/store";
import { windowLimits } from "../window/limits";
import { encodeWindow, MediaCleanupError } from "./encode-window";
import { representationParameters } from "./representation";
import { prepareClipDirectory } from "./clip-files";

export class WindowMediaError extends Error {
  constructor(
    readonly reason:
      | "not_found"
      | "unavailable"
      | "ineligible"
      | "not_ready"
      | "capacity",
    message: string,
  ) {
    super(message);
  }
}
function product(view: z.infer<typeof mediaViewSchema>) {
  return {
    view,
    path: null as string | null,
    readers: 0,
    expiresAt: performance.now() + Math.max(0, view.readableUntil - Date.now()),
    controller: new AbortController(),
    pending: undefined as Promise<void> | undefined,
    removing: undefined as Promise<void> | undefined,
  };
}
function expired(item: ReturnType<typeof product>) {
  return (
    Date.now() >= item.view.readableUntil || performance.now() >= item.expiresAt
  );
}
function key(
  summary: Pick<z.infer<typeof windowSummarySchema>, "id" | "crop" | "audio">,
  selection: z.infer<typeof mediaSelectionSchema>,
) {
  const { representation, includeAudio } = selection;
  const normalized =
    summary.crop === null && representation === "crop_video"
      ? "video"
      : summary.crop === null && representation === "crop_image"
        ? "image"
        : representation;
  const audio =
    normalized.endsWith("video") &&
    includeAudio &&
    summary.audio.status === "available";
  return `${summary.id}:${normalized}:${audio}`;
}
function recordingSelection(summary: z.infer<typeof windowSummarySchema>) {
  return {
    representation:
      summary.gate.candidate === "audio"
        ? ("audio" as const)
        : ("video" as const),
    includeAudio: summary.audio.status === "available",
  };
}
export function createWindowMedia(
  store: ReturnType<typeof createWindowStore>,
  executable: string,
  directory: string,
) {
  const products = new Map<string, ReturnType<typeof product>>();
  const recordings = new Map<string, ReturnType<typeof product>>();
  const queue = new PQueue({ concurrency: windowLimits.encodingConcurrency });
  let bytes = 0,
    inputBytes = 0,
    reservedBytes = 0,
    closed = false;
  let storageError: string | null = null;
  const ready = prepareClipDirectory(directory).catch((cause: unknown) => {
    storageError = String(cause).slice(0, 1024);
    console.error("Clip cache initialization failed", cause);
  });
  const readClosures = new Set<Promise<void>>();

  function window(id: string) {
    const entry = store.describe(id, Date.now());
    if (!entry) throw new WindowMediaError("not_found", "Window unavailable");
    if (entry.inputState === "revoked")
      throw new WindowMediaError("unavailable", "Window access revoked");
    return entry;
  }
  function view(
    entry: z.infer<typeof windowSummarySchema>,
    selection: z.infer<typeof mediaSelectionSchema>,
  ) {
    const existing = products.get(key(entry, selection));
    const result: z.infer<typeof mediaViewSchema> = existing?.view ?? {
      windowId: entry.id,
      representation: selection.representation,
      state: "not_generated",
      readableUntil: entry.closedAt + windowLimits.recordingMs,
      mediaId: null,
      bytes: 0,
      contentType: null,
      error: null,
      parameters: representationParameters(entry, selection),
    };
    return {
      ...result,
      representation: selection.representation,
      state: (existing ? expired(existing) : Date.now() >= result.readableUntil)
        ? ("expired" as const)
        : !existing && entry.inputState !== "available"
          ? entry.inputState
          : result.state,
    };
  }
  async function discard(
    item: ReturnType<typeof product>,
    state: "expired" | "evicted" | "revoked",
  ) {
    item.view.state = state;
    // Time/capacity cleanup allows an already admitted read to finish. Revocation does not.
    if (state === "revoked")
      item.controller.abort(new Error("Clip access revoked"));
    if (item.readers || item.pending) return;
    if (item.removing) return item.removing;
    const path = item.path;
    if (!path) return;
    item.removing = rm(path, { force: true })
      .then(() => {
        bytes -= item.view.bytes;
        item.path = null;
      })
      .finally(() => {
        item.removing = undefined;
      });
    await item.removing;
  }
  async function makeRoom(size: number) {
    if (bytes + reservedBytes + size <= windowLimits.productsBytes) return;
    for (const item of [...products.values()].toSorted(
      (a, b) => a.view.readableUntil - b.view.readableUntil,
    )) {
      if (item.path && !item.readers && !item.pending)
        await discard(item, "evicted");
      if (bytes + reservedBytes + size <= windowLimits.productsBytes) return;
    }
    throw new WindowMediaError("capacity", "Clip disk capacity exhausted");
  }
  function prune() {
    for (const [id, item] of products) {
      const entry = store.access(item.view.windowId, Date.now());
      const state =
        entry?.inputState === "revoked"
          ? ("revoked" as const)
          : !entry || expired(item)
            ? ("expired" as const)
            : item.view.state === "evicted"
              ? ("evicted" as const)
              : null;
      if (!state) continue;
      if (!item.path && !item.pending && !item.readers) {
        item.view.state = state;
        if (!entry) {
          products.delete(id);
          if (recordings.get(item.view.windowId) === item)
            recordings.delete(item.view.windowId);
        }
        continue;
      }
      if (item.pending) item.controller.abort(new Error(`Clip ${state}`));
      discard(item, state).catch((cause: unknown) => {
        storageError = String(cause).slice(0, 1024);
        console.error("Clip cleanup failed", cause);
      });
    }
  }
  function request(id: string, input: z.infer<typeof mediaRequestSchema>) {
    if (closed)
      throw new WindowMediaError("unavailable", "Media manager closed");
    prune();
    const entry = window(id);
    if (
      entry.gate.candidate === "none" ||
      (entry.gate.candidate === "audio" && input.representation !== "audio")
    )
      throw new WindowMediaError(
        "ineligible",
        "Representation is not eligible for this candidate",
      );
    const idKey = key(entry, input);
    const previous = products.get(idKey);
    if (previous && (previous.view.state !== "failed" || !input.retry))
      return view(entry, input);
    if (entry.inputState !== "available")
      throw new WindowMediaError(
        "unavailable",
        "Original window input is no longer available",
      );
    const lease = store.acquire(id, Date.now());
    if (!lease)
      throw new WindowMediaError("unavailable", "Window input unavailable");
    if (
      queue.size + queue.pending >= windowLimits.encodingQueue ||
      inputBytes + lease.bytes > windowLimits.encodingInputBytes
    )
      throw new WindowMediaError("capacity", "Clip encoding queue is full");
    const item = product({
      ...view(entry, input),
      state: "queued",
      error: null,
    });
    products.set(idKey, item);
    if (idKey === key(entry, recordingSelection(entry)))
      recordings.set(id, item);
    inputBytes += lease.bytes;
    const signal = AbortSignal.any([
      lease.authorizationSignal,
      item.controller.signal,
      AbortSignal.timeout(windowLimits.encodingWaitMs),
    ]);
    // The bounded encoding operation owns these pixels after admission. Raw-cache eviction
    // cannot free them prematurely; authorization and the operation deadline still cancel it.
    // Cancellation belongs to the native operation: keep the queue slot until FFmpeg
    // has actually exited and temporary files have been removed.
    item.pending = queue
      .add(async () => {
        await ready;
        signal.throwIfAborted();
        if (storageError) throw new Error(storageError);
        item.view.state = "generating";
        const reservation =
          windowLimits.productBytes + windowLimits.windowBytes;
        await makeRoom(reservation);
        reservedBytes += reservation;
        let releaseReservation = true;
        const mediaId = crypto.randomUUID();
        const path = join(
          directory,
          `${mediaId}.${input.representation.endsWith("image") ? "jpg" : "mp4"}`,
        );
        try {
          const result = await encodeWindow(
            {
              ...lease.input,
              representation: input.representation,
              parameters: item.view.parameters,
            },
            executable,
            AbortSignal.any([
              signal,
              AbortSignal.timeout(windowLimits.encodingMs),
            ]),
            path,
          );
          item.path = path;
          item.view.bytes = result.bytes;
          bytes += result.bytes;
          if (!store.access(id, Date.now()))
            throw new WindowMediaError("not_found", "Window unavailable");
          signal.throwIfAborted();
          item.view = {
            ...item.view,
            state: "ready",
            mediaId,
            contentType: result.contentType,
          };
        } catch (cause) {
          if (cause instanceof MediaCleanupError) {
            storageError = cause.message;
            releaseReservation = false;
          }
          if (!item.path) {
            try {
              await rm(path, { force: true });
            } catch (cleanupError) {
              storageError = String(cleanupError).slice(0, 1024);
              releaseReservation = false;
              throw cleanupError;
            }
          }
          throw cause;
        } finally {
          if (releaseReservation) reservedBytes -= reservation;
        }
      })
      .catch((cause: unknown) => {
        const access = store.access(id, Date.now());
        item.view.state =
          !access || access.inputState === "revoked" ? "revoked" : "failed";
        item.view.error = String(cause).slice(0, 1024);
      })
      .finally(async () => {
        inputBytes -= lease.bytes;
        item.pending = undefined;
        if (item.path && item.view.state !== "ready")
          await discard(item, "evicted");
      });
    // Own cleanup failures as well as encoding failures; never lose accounting silently.
    item.pending.catch((cause: unknown) => {
      storageError = String(cause).slice(0, 1024);
      console.error("Clip encoding cleanup failed", cause);
    });
    return view(entry, input);
  }
  function capture(id: string) {
    const entry = window(id);
    const selection = recordingSelection(entry);
    try {
      request(id, { ...selection, retry: false });
    } catch (cause) {
      const item = product({
        ...view(entry, selection),
        state: "failed",
        error: String(cause).slice(0, 1024),
      });
      products.set(key(entry, selection), item);
      recordings.set(id, item);
    }
  }
  return {
    capture,
    prune,
    view(id: string, selection: z.infer<typeof mediaSelectionSchema>) {
      return view(window(id), selection);
    },
    request,
    recording(id: string) {
      const item = recordings.get(id);
      if (!item) return null;
      const access = store.access(id, Date.now());
      if (!access || access.inputState === "revoked") return null;
      return {
        selection: {
          representation: item.view.representation,
          includeAudio: item.view.parameters.audioIncluded,
        },
        state: expired(item) ? ("expired" as const) : item.view.state,
        readableUntil: item.view.readableUntil,
        error: item.view.error,
      };
    },
    read(
      id: string,
      selection: z.infer<typeof mediaSelectionSchema>,
      mediaId: string,
      requestSignal: AbortSignal,
    ) {
      prune();
      const entry = window(id);
      const item = products.get(key(entry, selection));
      const state = view(entry, selection).state;
      if (state === "expired" || state === "evicted" || state === "revoked")
        throw new WindowMediaError("unavailable", `Clip ${state}`);
      if (!item?.path || state !== "ready" || item.view.mediaId !== mediaId)
        throw new WindowMediaError("not_ready", "Media product not ready");
      if (readClosures.size >= windowLimits.reads)
        throw new WindowMediaError("capacity", "Media read capacity exhausted");
      const access = store.acquireRead(id, Date.now());
      if (!access)
        throw new WindowMediaError("not_found", "Window unavailable");
      const signal = AbortSignal.any([
        requestSignal,
        access.signal,
        item.controller.signal,
        AbortSignal.timeout(windowLimits.readMs),
      ]);
      let stream: ReturnType<typeof createReadStream>;
      try {
        stream = createReadStream(item.path, {
          signal,
          highWaterMark: windowLimits.readChunkBytes,
        });
      } catch (cause) {
        access.release();
        throw cause;
      }
      item.readers++;
      const finished = new Promise<void>((resolve) => {
        stream.once("close", () => {
          access.release();
          item.readers--;
          readClosures.delete(finished);
          resolve();
        });
      });
      readClosures.add(finished);
      return {
        stream: Readable.toWeb(stream),
        contentType: item.view.contentType!,
        bytes: item.view.bytes,
      };
    },
    snapshot() {
      prune();
      return {
        encoding: queue.pending,
        queued: queue.size,
        encodingInputBytes: inputBytes,
        reads: readClosures.size,
        productBytes: bytes,
        reservedBytes,
        products: products.size,
        retentionMs: windowLimits.recordingMs,
        maxBytes: windowLimits.productsBytes,
        error: storageError,
      };
    },
    async close() {
      closed = true;
      for (const item of products.values())
        item.controller.abort(new Error("Media stopped"));
      const encodingResults = await Promise.allSettled(
        [...products.values()].flatMap((item) =>
          item.pending ? [item.pending] : [],
        ),
      );
      await queue.onIdle();
      await Promise.all(readClosures);
      await ready;
      const cleanupResults = await Promise.allSettled(
        [...products.values()].map((item) => discard(item, "revoked")),
      );
      products.clear();
      recordings.clear();
      const failures = [...encodingResults, ...cleanupResults].flatMap(
        (result) => (result.status === "rejected" ? [result.reason] : []),
      );
      if (failures.length)
        throw new AggregateError(failures, "Clip cleanup failed");
    },
  };
}
