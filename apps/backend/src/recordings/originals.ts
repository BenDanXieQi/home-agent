import { join } from "node:path";
import pTimeout from "p-timeout";
import type { z } from "zod";
import { MijiaError } from "../mijia/errors";
import {
  MediaCleanupError,
  type createMediaResources,
} from "../media/resources";
import { recordingTransferLimits } from "../mijia/media/recording-file";
import type { createSdRecordingSource } from "../mijia/recordings/source";
import { sourceKey, type sourceSelectionSchema } from "../perception/config";
import { prepareSourceLease } from "../perception/source-lease";
import { captureRecording } from "./capture";
import { selectSegments } from "./selection";
import type { createRecordingsService, readMediaInputSchema } from "./service";

type MediaResource = ReturnType<
  ReturnType<typeof createMediaResources>["create"]
>;
type Segment = Parameters<Parameters<typeof captureRecording>[0]["closed"]>[0];
type SdSource = ReturnType<typeof createSdRecordingSource>;
type SdInput = Parameters<SdSource["index"]>[0] & { startAt: number };

function original(
  input: {
    source: "local" | "sd";
    deviceId: string;
    channel: 1 | 2;
    identity: string;
    startedAt: number;
    endedAt: number;
  },
  path: string,
  resource: MediaResource,
) {
  return {
    ...input,
    path,
    resource,
    segment: undefined as Segment | undefined,
    download: undefined as
      | Promise<Awaited<ReturnType<SdSource["download"]>>>
      | undefined,
    users: new Set<object>(),
  };
}

export function createRecordingOriginals(
  options: Pick<
    Parameters<typeof createRecordingsService>[0],
    "sources" | "sd"
  > & {
    storage: () => {
      resources: ReturnType<typeof createMediaResources>;
      root: string;
    };
    signal: AbortSignal;
  },
) {
  const available = options.storage;
  const originals = new Map<string, ReturnType<typeof original>>();
  const readers = new Set<ReturnType<typeof reader>>();
  function reader(input: {
    signal: AbortSignal;
    cancel: (reason?: Error) => void;
  }) {
    return {
      input,
      held: new Map<ReturnType<typeof original>, () => void>(),
      sources: new Map<string, ReturnType<typeof original>>(),
      finished: Promise.withResolvers<void>(),
    };
  }
  function makeOriginal(
    key: string,
    input: Parameters<typeof original>[0],
    path: string,
  ) {
    const budget = available().resources;
    const resource = budget.create(null, () => {
      if (originals.get(key)?.resource === resource) originals.delete(key);
    });
    budget.claim(resource, path);
    const entry = original(input, path, resource);
    originals.set(key, entry);
    return entry;
  }
  function hold(
    item: ReturnType<typeof reader>,
    entry: ReturnType<typeof original>,
  ) {
    if (!item.held.has(entry)) {
      item.held.set(entry, available().resources.use(entry.resource));
      entry.users.add(item);
      item.sources.set(sourceKey(entry), entry);
    }
  }
  function beginRead(request: {
    signal: AbortSignal;
    cancel: (reason?: Error) => void;
  }) {
    const budget = available().resources;
    request.signal.throwIfAborted();
    const item = reader(request);
    readers.add(item);
    let released: Promise<void> | undefined;
    async function borrowSd(
      input: SdInput,
      source: ReturnType<SdSource["access"]>,
    ) {
      item.input.signal.throwIfAborted();
      source.assertCurrent();
      const eligibility = options.sources.eligibility(input);
      if (!eligibility) throw new MijiaError("stale_session");
      const key = `sd:${sourceKey(input)}:${input.startAt}`;
      let entry = originals.get(key);
      if (!entry) {
        entry = makeOriginal(
          key,
          {
            ...input,
            source: "sd",
            identity: eligibility.identity,
            startedAt: input.startAt,
            endedAt: input.startAt,
          },
          join(available().root, `${crypto.randomUUID()}.mp4`),
        );
      }
      hold(item, entry);
      const current = entry;
      const download = (current.download ??= budget.execute(current.resource, {
        reservation: recordingTransferLimits.bytes,
        signal: AbortSignal.any([
          current.resource.generation.signal,
          source.signal,
          options.signal,
        ]),
        generate: async () => {
          const product = await options.sd.download(
            source,
            input.startAt,
            current.path,
            current.resource.generation.signal,
            () =>
              budget.openWriter(
                current.resource,
                current.resource.generation.signal,
              ),
          );
          await budget.publish(current.resource, current.path, product.bytes);
          current.endedAt = current.startedAt + product.media.actualDurationMs;
          return product;
        },
        failed: (cause) => {
          budget.invalidate(current.resource, "cancelled");
          console.warn("Recording download failed", cause);
          for (const waiting of readers) {
            waiting.held.get(current)?.();
            waiting.held.delete(current);
            current.users.delete(waiting);
          }
        },
      }));
      const result = await pTimeout(download, {
        milliseconds: Infinity,
        signal: item.input.signal,
      });
      item.input.signal.throwIfAborted();
      source.assertCurrent();
      return { path: entry.path, media: result.media };
    }
    function release() {
      released ??= Promise.resolve().then(async () => {
        const retiring: Promise<void>[] = [];
        try {
          for (const [entry, releaseUse] of item.held) {
            releaseUse();
            entry.users.delete(item);
            if (!entry.users.size && entry.resource.pending) {
              retiring.push(budget.retire(entry.resource, "cancelled"));
            }
          }
          await Promise.all(retiring);
        } finally {
          item.held.clear();
          readers.delete(item);
          item.finished.resolve();
        }
      });
      return released;
    }
    function releaseOriginals() {
      for (const [entry, releaseUse] of item.held) {
        releaseUse();
        entry.users.delete(item);
      }
      item.held.clear();
    }
    function localSegments(input: z.infer<typeof readMediaInputSchema>) {
      const entries = selectSegments(
        [...originals.values()].filter(
          (entry) =>
            entry.source === "local" &&
            sourceKey(entry) === sourceKey(input) &&
            entry.segment,
        ),
        input.selection,
      );
      for (const entry of entries) hold(item, entry);
      return entries.map((entry) => entry.segment!);
    }
    function quarantine() {
      for (const entry of item.held.keys()) entry.resource.quarantined = true;
    }
    return { borrowSd, localSegments, releaseOriginals, quarantine, release };
  }
  async function capture(
    source: z.infer<typeof sourceSelectionSchema>,
    identity: string,
    controller: AbortController,
  ) {
    const { resources: budget, root } = available();
    let writing:
      | { entry: ReturnType<typeof original>; release: () => void }
      | undefined;
    try {
      const access = await prepareSourceLease(
        options.sources,
        source,
        controller.signal,
        () => controller.abort(new Error("Recording media retired")),
      );
      await captureRecording({
        directory: root,
        access,
        signal: controller.signal,
        openOutput: (path) => {
          controller.signal.throwIfAborted();
          const entry = makeOriginal(
            path,
            {
              ...source,
              source: "local",
              identity,
              startedAt: Infinity,
              endedAt: Infinity,
            },
            path,
          );
          writing = { entry, release: budget.use(entry.resource) };
          return budget.openWriter(entry.resource, controller.signal);
        },
        closed: async (segment) => {
          controller.signal.throwIfAborted();
          const { entry, release } = writing!;
          await budget.publish(
            entry.resource,
            segment.path,
            segment.media.bytes,
          );
          entry.segment = segment;
          entry.startedAt = segment.startedAt;
          entry.endedAt = segment.endedAt;
          release();
          writing = undefined;
        },
      });
    } catch (cause) {
      if (cause instanceof MediaCleanupError && writing)
        writing.entry.resource.quarantined = true;
      throw cause;
    } finally {
      if (writing) {
        writing.release();
        await budget.retire(writing.entry.resource, "cancelled");
      }
    }
  }
  function reconcile() {
    for (const item of readers) {
      if (
        [...item.sources.values()].some(
          (source) =>
            options.sources.eligibility(source)?.identity !== source.identity,
        )
      )
        item.input.cancel(new MijiaError("stale_session"));
    }
    for (const entry of originals.values()) {
      if (options.sources.eligibility(entry)?.identity !== entry.identity) {
        available().resources.invalidate(entry.resource, "revoked");
      }
    }
  }
  async function close() {
    for (const item of readers)
      item.input.cancel(new Error("Recordings stopped"));
    await Promise.all([...readers].map((item) => item.finished.promise));
  }
  return { beginRead, capture, reconcile, close };
}
