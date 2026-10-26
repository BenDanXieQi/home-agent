import { createRecordingOriginals } from "./originals";
import { readRecordingMedia } from "./read";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import pTimeout from "p-timeout";
import { z } from "zod";
import { prepareClipDirectory } from "../media/clip-files";
import { createMediaResources, MediaCleanupError } from "../media/resources";
import { AppError } from "@home-agent/api/errors";
import { MijiaError } from "../mijia/errors";
import type { createSdRecordingSource } from "../mijia/recordings/source";
import type { readPerceptionConfigFile } from "../perception/config-file";
import {
  perceptionSourceLimit,
  perceptionConfigSchema,
  sourceKey,
  sourceSelectionSchema,
} from "../perception/config";
import { selectSources, type PerceptionSources } from "../perception/sources";
import { recordingsConfigSchema } from "./config";

export const recordingReadMs = 120_000;

const storageConfigSchema = z.object({
  recordings: recordingsConfigSchema.prefault({}),
});
const captureConfigSchema = z.object({
  sources: perceptionConfigSchema.shape.sources,
  sourceProfiles: perceptionConfigSchema.shape.sourceProfiles,
});

const dimensions = {
  width: z.int().positive().optional(),
  height: z.int().positive().optional(),
};
export const recordingSourceSchema = sourceSelectionSchema.pick({
  deviceId: true,
  channel: true,
});
export const readMediaInputSchema = z
  .strictObject({
    ...recordingSourceSchema.shape,
    source: z.enum(["local", "sd"]).optional(),
    selection: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("at"), at: z.number() }),
      z
        .strictObject({
          kind: z.literal("range"),
          start: z.number(),
          end: z.number(),
        })
        .refine(
          (value) => value.start < value.end,
          "Range start must precede end",
        ),
    ]),
    crop: z
      .strictObject({
        x: z.number().nonnegative(),
        y: z.number().nonnegative(),
        w: z.number().positive(),
        h: z.number().positive(),
      })
      .refine(
        (value) => value.x + value.w <= 1 && value.y + value.h <= 1,
        "Crop exceeds the original image",
      )
      .optional(),
    output: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("image"), ...dimensions }),
      z.strictObject({
        kind: z.literal("images"),
        ...dimensions,
        fps: z.number().positive(),
      }),
      z.strictObject({
        kind: z.literal("video"),
        ...dimensions,
        fps: z.number().positive().optional(),
        codec: z.enum(["h264", "h265"]).optional(),
      }),
    ]),
  })
  .refine(
    (value) =>
      (value.selection.kind === "at") === (value.output.kind === "image"),
    "A single time requires an image; a range requires images or video",
  );

export function createRecordingsService(options: {
  sources: PerceptionSources;
  readConfig: () => ReturnType<typeof readPerceptionConfigFile>;
  executable: string;
  directory: string;
  sd: ReturnType<typeof createSdRecordingSource>;
}) {
  const stopping = new AbortController();
  const originals = createRecordingOriginals({
    ...options,
    storage: available,
    signal: stopping.signal,
  });
  const runs = new Map<
    string,
    { identity: string; controller: AbortController; pending: Promise<void> }
  >();
  const retries = new Map<
    string,
    {
      identity: string;
      timer: ReturnType<typeof setTimeout> | undefined;
      delayMs: number;
      error: string | undefined;
    }
  >();
  let config: z.infer<typeof captureConfigSchema> | undefined;
  let resources: ReturnType<typeof createMediaResources> | undefined;
  let instanceDirectory: string | undefined;
  let initializing: Promise<void> | undefined;
  let starting: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let unsubscribe: (() => void) | undefined;

  function available() {
    stopping.signal.throwIfAborted();
    if (!resources || !instanceDirectory)
      throw new AppError("perception_media_unavailable");
    if (resources.snapshot.error)
      throw new MediaCleanupError(resources.snapshot.error);
    return { resources, root: instanceDirectory };
  }
  async function beginRead(request: Parameters<typeof originals.beginRead>[0]) {
    await ensureStorage();
    return originals.beginRead(request);
  }
  async function readMedia(
    value: z.infer<typeof readMediaInputSchema>,
    requestSignal: AbortSignal,
  ) {
    const input = readMediaInputSchema.parse(value);
    if (input.source === "local") await startService();
    else await ensureStorage();
    if (!options.sources.eligibility(input))
      throw new MijiaError("stale_session");
    return readRecordingMedia(input, {
      storage: available(),
      originals,
      sd: options.sd,
      executable: options.executable,
      signal: AbortSignal.any([requestSignal, stopping.signal]),
    });
  }
  function reconcile() {
    if (!resources || stopping.signal.aborted) return;
    const selected = config
      ? selectSources(config, options.sources.list())
      : [];
    const keys = new Set(
      selected.length <= perceptionSourceLimit ? selected.map(sourceKey) : [],
    );
    originals.reconcile();
    for (const [key, run] of runs) {
      const source = selected.find((candidate) => sourceKey(candidate) === key);
      if (
        !source ||
        !keys.has(key) ||
        options.sources.eligibility(source)?.identity !== run.identity
      )
        run.controller.abort(new MijiaError("stale_session"));
    }
    for (const [key, retry] of retries) {
      const source = selected.find((candidate) => sourceKey(candidate) === key);
      if (
        !source ||
        !keys.has(key) ||
        options.sources.eligibility(source)?.identity !== retry.identity
      ) {
        clearTimeout(retry.timer);
        retries.delete(key);
      }
    }
    if (selected.length > perceptionSourceLimit) return;
    for (const source of selected) {
      const key = sourceKey(source);
      const access = options.sources.eligibility(source);
      if (!access || runs.has(key) || retries.get(key)?.timer) continue;
      const retry = retries.get(key) ?? {
        identity: access.identity,
        timer: undefined,
        delayMs: 5000,
        error: undefined,
      };
      retries.set(key, retry);
      const controller = new AbortController();
      const run = {
        identity: access.identity,
        controller,
        pending: Promise.resolve(),
      };
      runs.set(key, run);
      run.pending = originals
        .capture(source, access.identity, controller, () => {
          retry.delayMs = 5000;
          retry.error = undefined;
        })
        .catch((cause) => {
          if (controller.signal.aborted) return;
          const message =
            cause instanceof Error ? cause.message : String(cause);
          if (retry.error !== message)
            console.warn(
              "Recording capture failed; retrying automatically",
              cause,
            );
          retry.error = message;
        })
        .finally(() => {
          runs.delete(key);
          if (
            !stopping.signal.aborted &&
            retries.get(key) === retry &&
            options.sources.eligibility(source)?.identity === run.identity
          ) {
            retry.timer = setTimeout(() => {
              retry.timer = undefined;
              reconcile();
            }, retry.delayMs);
            retry.delayMs = Math.min(retry.delayMs * 2, 60_000);
          } else if (!stopping.signal.aborted) reconcile();
        });
    }
  }
  function ensureStorage() {
    initializing ??= (async () => {
      const { recordings: settings } = storageConfigSchema.parse(
        await options.readConfig(),
      );
      stopping.signal.throwIfAborted();
      await prepareClipDirectory(options.directory);
      const directory = await mkdtemp(join(options.directory, "instance-"));
      if (stopping.signal.aborted) {
        await rm(directory, { recursive: true, force: true });
        stopping.signal.throwIfAborted();
      }
      instanceDirectory = directory;
      resources = createMediaResources({
        bytes: settings.cacheBytes,
        readMs: recordingReadMs,
        readTimeout: "idle",
        readChunkBytes: 64 * 1024,
        eviction: "oldest",
        interruptExpiredReads: true,
      });
      unsubscribe = options.sources.subscribe(reconcile);
      reconcile();
    })().catch((cause: unknown) => {
      initializing = undefined;
      throw cause;
    });
    return initializing;
  }
  function startService() {
    starting ??= (async () => {
      await ensureStorage();
      config = captureConfigSchema.parse(await options.readConfig());
      stopping.signal.throwIfAborted();
      reconcile();
    })().catch((cause: unknown) => {
      starting = undefined;
      throw cause;
    });
    return starting;
  }
  function close() {
    closing ??= (async () => {
      stopping.abort(new Error("Recordings stopped"));
      await pTimeout(Promise.allSettled([initializing, starting]), {
        milliseconds: 3000,
        message: new MediaCleanupError("Recording initialization did not stop"),
      });
      for (const retry of retries.values()) clearTimeout(retry.timer);
      retries.clear();
      unsubscribe?.();
      for (const run of runs.values())
        run.controller.abort(stopping.signal.reason);
      await Promise.all([
        pTimeout(
          Promise.all([
            ...[...runs.values()].map((run) => run.pending),
            originals.close(),
          ]),
          {
            milliseconds: 3000,
            message: new MediaCleanupError("Recording operations did not stop"),
          },
        ),
        resources?.close(),
      ]);
      if (instanceDirectory)
        await rm(instanceDirectory, { recursive: true, force: true });
    })();
    return closing;
  }
  return {
    start: startService,
    close,
    readMedia,
    beginRead,
    covers: originals.covers,
    subscribe: originals.subscribe,
    async ranges(target: Parameters<typeof originals.ranges>[0]) {
      await startService();
      return originals.ranges(target);
    },
  };
}
