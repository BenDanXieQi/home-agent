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
    data: null as Buffer | null,
    controller: new AbortController(),
    pending: undefined as Promise<void> | undefined,
  };
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
export function createWindowMedia(
  store: ReturnType<typeof createWindowStore>,
  executable: string,
) {
  const products = new Map<string, ReturnType<typeof product>>();
  let active = 0,
    reads = 0,
    bytes = 0,
    closed = false;
  const reading = new Set<AbortController>();
  function window(id: string) {
    const entry = store.describe(id, Date.now());
    if (!entry) throw new WindowMediaError("not_found", "Window unavailable");
    if (entry.inputState !== "available")
      throw new WindowMediaError("unavailable", `Window ${entry.inputState}`);
    return entry;
  }
  function access(id: string) {
    const entry = store.access(id, Date.now());
    if (!entry) throw new WindowMediaError("not_found", "Window unavailable");
    if (entry.inputState !== "available")
      throw new WindowMediaError("unavailable", `Window ${entry.inputState}`);
    return entry;
  }
  function view(id: string, selection: z.infer<typeof mediaSelectionSchema>) {
    const { representation } = selection;
    const entry = store.describe(id, Date.now());
    if (!entry) throw new WindowMediaError("not_found", "Window unavailable");
    const existing = products.get(key(entry, selection));
    const result: z.infer<typeof mediaViewSchema> = existing?.view ?? {
      windowId: id,
      representation,
      state: "not_generated",
      readableUntil: entry.readableUntil,
      mediaId: null,
      bytes: 0,
      contentType: null,
      error: null,
      parameters: representationParameters(entry, selection),
    };
    return {
      ...result,
      representation,
      state: entry.inputState === "available" ? result.state : entry.inputState,
    };
  }
  function prune() {
    for (const [id, item] of products) {
      const entry = store.access(item.view.windowId, Date.now());
      if (!entry || entry.inputState !== "available") {
        item.controller.abort(new Error("Window input unavailable"));
        if (item.data) {
          bytes -= item.data.length;
          item.data = null;
        }
        if (entry && entry.inputState !== "available")
          item.view.state = entry.inputState;
        else products.delete(id);
      }
    }
  }
  return {
    view,
    request(id: string, request: z.infer<typeof mediaRequestSchema>) {
      if (closed)
        throw new WindowMediaError("unavailable", "Media manager closed");
      prune();
      const entry = window(id);
      if (
        entry.gate.candidate === "none" ||
        (entry.gate.candidate === "audio" && request.representation !== "audio")
      )
        throw new WindowMediaError(
          "ineligible",
          "Representation is not eligible for this candidate",
        );
      const idKey = key(entry, request);
      const previous = products.get(idKey);
      if (previous && (previous.view.state !== "failed" || !request.retry))
        return view(id, request);
      if (
        active >= windowLimits.encodingConcurrency ||
        bytes + windowLimits.productBytes > windowLimits.productsBytes
      )
        throw new WindowMediaError(
          "capacity",
          "Media encoding capacity exhausted",
        );
      if (entry.readableUntil - Date.now() < 250)
        throw new WindowMediaError(
          "unavailable",
          "Insufficient media lifetime",
        );
      const lease = store.acquire(id, Date.now());
      if (!lease)
        throw new WindowMediaError("unavailable", "Window input unavailable");
      const item = product({
        ...view(id, request),
        state: "generating",
        error: null,
      });
      products.set(idKey, item);
      active++;
      const deadline = setTimeout(
        () => item.controller.abort(new Error("Media deadline exceeded")),
        Math.min(5000, entry.readableUntil - Date.now()),
      );
      const signal = AbortSignal.any([lease.signal, item.controller.signal]);
      item.pending = encodeWindow(lease, request, executable, signal)
        .then((result) => {
          access(id);
          signal.throwIfAborted();
          item.data = result.data;
          bytes += result.data.length;
          item.view = {
            ...item.view,
            state: "ready",
            mediaId: crypto.randomUUID(),
            bytes: result.data.length,
            contentType: result.contentType,
            parameters: result.parameters,
          };
        })
        .catch((error: unknown) => {
          const state = store.access(id, Date.now())?.inputState;
          item.view.state =
            state === "available" ? "failed" : (state ?? "expired");
          item.view.error = String(error).slice(0, 1024);
        })
        .finally(() => {
          active--;
          clearTimeout(deadline);
        });
      return view(id, request);
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
      if (
        !item?.data ||
        item.view.state !== "ready" ||
        item.view.mediaId !== mediaId
      )
        throw new WindowMediaError("not_ready", "Media product not ready");
      if (reads >= windowLimits.reads)
        throw new WindowMediaError("capacity", "Media read capacity exhausted");
      const lease = access(id);
      reads++;
      const owned = new AbortController();
      reading.add(owned);
      const signal = AbortSignal.any([
        requestSignal,
        owned.signal,
        lease.signal,
        item.controller.signal,
      ]);
      const data = item.data;
      let offset = 0,
        released = false;
      let streamController:
        | ReadableStreamDefaultController<Uint8Array>
        | undefined;
      const release = () => {
        if (released) return;
        released = true;
        reads--;
        reading.delete(owned);
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        streamController?.error(signal.reason);
        release();
      };
      const timer = setTimeout(
        () => owned.abort(new Error("Media read expired")),
        Math.max(1, entry.readableUntil - Date.now()),
      );
      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            streamController = controller;
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          },
          pull(controller) {
            if (released) return;
            try {
              access(id);
              signal.throwIfAborted();
              if (offset === data.length) {
                controller.close();
                release();
                return;
              }
              const end = Math.min(
                data.length,
                offset + windowLimits.readChunkBytes,
              );
              controller.enqueue(new Uint8Array(data.subarray(offset, end)));
              offset = end;
            } catch (error) {
              controller.error(error);
              release();
            }
          },
          cancel() {
            release();
          },
        },
        { highWaterMark: 1 },
      );
      return {
        stream,
        contentType: item.view.contentType!,
        bytes: data.length,
      };
    },
    snapshot() {
      prune();
      return {
        encoding: active,
        reads,
        productBytes: bytes,
        products: products.size,
      };
    },
    async close() {
      closed = true;
      for (const controller of reading)
        controller.abort(new Error("Media stopped"));
      for (const item of products.values())
        item.controller.abort(new Error("Media stopped"));
      await Promise.all(
        [...products.values()].flatMap((item) =>
          item.pending ? [item.pending] : [],
        ),
      );
      products.clear();
      bytes = 0;
    },
  };
}
