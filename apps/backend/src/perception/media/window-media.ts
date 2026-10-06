import { join } from "node:path";
import type { z } from "zod";
import type {
  mediaSelectionSchema,
  mediaViewSchema,
  mediaRequestSchema,
  windowSummarySchema,
} from "@home-agent/api/contracts";
import type { createWindowStore } from "../window/store";
import { windowLimits } from "../window/limits";
import { encodeWindow } from "./encode-window";
import { representationParameters } from "./representation";
import { prepareClipDirectory } from "../../media/clip-files";
import {
  createMediaResources,
  mediaExpired,
  MediaCapacityError,
} from "../../media/resources";

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
class WindowProduct {
  readonly media;
  constructor(
    public view: z.infer<typeof mediaViewSchema>,
    resources: ReturnType<typeof createMediaResources>,
    changed: () => void,
  ) {
    this.media = resources.create(view.readableUntil, (reason) => {
      const state = reason === "cancelled" ? "revoked" : reason;
      if (this.view.state === state) return;
      this.view.state = state;
      changed();
    });
  }
  get state() {
    return mediaExpired(this.media) ? ("expired" as const) : this.view.state;
  }
}
function key(
  summary: Pick<
    z.infer<typeof windowSummarySchema>,
    "id" | "crop" | "audio" | "gate"
  >,
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
  const sampled = defaultSelection(summary);
  return normalized === sampled.representation &&
    audio === (normalized === "video" && sampled.includeAudio)
    ? `${summary.id}:sampled`
    : `${summary.id}:${normalized}:${audio}`;
}
function defaultSelection(
  summary: Pick<z.infer<typeof windowSummarySchema>, "gate" | "audio">,
) {
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
  const products = new Map<string, WindowProduct>();
  const listeners = new Set<() => void>();
  function changed() {
    for (const listener of listeners) {
      try {
        listener();
      } catch (cause) {
        console.error("Window media notification failed", cause);
      }
    }
  }
  const resources = createMediaResources({
    bytes: windowLimits.productsBytes,
    concurrency: windowLimits.encodingConcurrency,
    readers: windowLimits.reads,
    readMs: windowLimits.readMs,
    readChunkBytes: windowLimits.readChunkBytes,
    eviction: "expiry",
    interruptExpiredReads: false,
  });
  let inputBytes = 0;
  let storageError: string | null = null;
  const ready = prepareClipDirectory(directory).catch((cause: unknown) => {
    storageError = String(cause).slice(0, 1024);
    console.error("Clip cache initialization failed", cause);
  });

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
      readableUntil: entry.closedAt + windowLimits.mediaRetentionMs,
      mediaId: null,
      bytes: 0,
      contentType: null,
      error: null,
      parameters: representationParameters(entry, selection),
    };
    return {
      ...result,
      representation: selection.representation,
      state: existing
        ? existing.state
        : Date.now() >= result.readableUntil
          ? ("expired" as const)
          : entry.inputState !== "available"
            ? entry.inputState
            : result.state,
    };
  }
  function prune() {
    for (const [id, item] of products) {
      const entry = store.access(item.view.windowId, Date.now());
      const state =
        entry?.inputState === "revoked"
          ? ("revoked" as const)
          : !entry || mediaExpired(item.media)
            ? ("expired" as const)
            : item.view.state === "evicted"
              ? ("evicted" as const)
              : null;
      if (!state) continue;
      resources.invalidate(item.media, state);
      if (
        !entry &&
        !item.media.path &&
        !item.media.pending &&
        !item.media.reads.size
      )
        products.delete(id);
    }
  }
  function request(id: string, input: z.infer<typeof mediaRequestSchema>) {
    if (resources.snapshot.closed)
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
      resources.snapshot.queued + resources.snapshot.encoding >=
        windowLimits.encodingQueue ||
      inputBytes + lease.bytes > windowLimits.encodingInputBytes
    )
      throw new WindowMediaError("capacity", "Clip encoding queue is full");
    if (previous) resources.invalidate(previous.media, "cancelled");
    const item = new WindowProduct(
      {
        ...view(entry, input),
        state: "queued",
        error: null,
      },
      resources,
      changed,
    );
    products.set(idKey, item);
    changed();
    inputBytes += lease.bytes;
    const signal = AbortSignal.any([
      lease.authorizationSignal,
      item.media.generation.signal,
      AbortSignal.timeout(windowLimits.encodingWaitMs),
    ]);
    resources.schedule(item.media, {
      reservation: windowLimits.productBytes + windowLimits.windowBytes,
      signal,
      generate: async () => {
        await ready;
        signal.throwIfAborted();
        if (storageError) throw new Error(storageError);
        item.view.state = "generating";
        changed();
        const mediaId = crypto.randomUUID();
        const path = join(
          directory,
          `${mediaId}.${input.representation.endsWith("image") ? "jpg" : "mp4"}`,
        );
        resources.claim(item.media, path);
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
        if (!store.access(id, Date.now()))
          throw new WindowMediaError("not_found", "Window unavailable");
        signal.throwIfAborted();
        resources.publish(item.media, path, result.bytes);
        item.view = {
          ...item.view,
          bytes: result.bytes,
          state: "ready",
          mediaId,
          contentType: result.contentType,
        };
        changed();
      },
      failed: (cause) => {
        if (item.media.retired) return;
        const access = store.access(id, Date.now());
        item.view.state =
          !access || access.inputState === "revoked" ? "revoked" : "failed";
        item.view.error = String(cause).slice(0, 1024);
        changed();
      },
    });
    const releaseInput = () => {
      inputBytes -= lease.bytes;
    };
    item.media.pending!.then(releaseInput, releaseInput);
    return view(entry, input);
  }
  function capture(id: string) {
    const entry = window(id);
    const selection = defaultSelection(entry);
    try {
      request(id, { ...selection, retry: false });
    } catch (cause) {
      const item = new WindowProduct(
        {
          ...view(entry, selection),
          state: "failed",
          error: String(cause).slice(0, 1024),
        },
        resources,
        changed,
      );
      products.set(key(entry, selection), item);
      changed();
    }
  }
  return {
    capture,
    prune,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    view(id: string, selection: z.infer<typeof mediaSelectionSchema>) {
      return view(window(id), selection);
    },
    request,
    sampledMedia(id: string) {
      const item = products.get(`${id}:sampled`);
      if (!item) return null;
      const access = store.access(id, Date.now());
      if (!access || access.inputState === "revoked") return null;
      return {
        selection: {
          representation: item.view.representation,
          includeAudio: item.view.parameters.audioIncluded,
        },
        state: item.state,
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
      if (
        !item?.media.path ||
        state !== "ready" ||
        item.view.mediaId !== mediaId
      )
        throw new WindowMediaError("not_ready", "Media product not ready");
      if (resources.snapshot.reads >= windowLimits.reads)
        throw new WindowMediaError("capacity", "Media read capacity exhausted");
      const access = store.acquireRead(id, Date.now());
      if (!access)
        throw new WindowMediaError("not_found", "Window unavailable");
      const signal = AbortSignal.any([requestSignal, access.signal]);
      try {
        return {
          stream: resources.read(item.media, signal, undefined, () => {
            access.release();
          }),
          contentType: item.view.contentType!,
          bytes: item.view.bytes,
        };
      } catch (cause) {
        access.release();
        if (cause instanceof MediaCapacityError)
          throw new WindowMediaError("capacity", cause.message);
        throw cause;
      }
    },
    snapshot() {
      prune();
      const state = resources.snapshot;
      return {
        encoding: state.encoding,
        queued: state.queued,
        encodingInputBytes: inputBytes,
        reads: state.reads,
        productBytes: state.bytes,
        reservedBytes: state.reservedBytes,
        products: products.size,
        retentionMs: windowLimits.mediaRetentionMs,
        maxBytes: windowLimits.productsBytes,
        error: storageError ?? state.error,
      };
    },
    async close() {
      await resources.close();
      await ready;
      products.clear();
      listeners.clear();
    },
  };
}
