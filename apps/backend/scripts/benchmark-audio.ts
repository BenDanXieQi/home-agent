import { parseArgs, promisify } from "node:util";
import { execFile } from "node:child_process";
import { ffmpegVersion } from "node-av/ffmpeg";
import { setTimeout as delay } from "node:timers/promises";
import { createHistogram, monitorEventLoopDelay } from "node:perf_hooks";
import { Hono } from "hono";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { z } from "zod";
import { createAudioSource } from "./perception-evaluation/audio-source";
import { createAudioResourceSampler } from "./perception-evaluation/audio-resources";
import { createLibavAudioDecoder } from "./perception-evaluation/audio-libav";
import { createAudioDecoder } from "../src/perception/audio/decoder";
import { createAudioAnalysis } from "../src/perception/audio/analysis";
import {
  createSileroTrack,
  createVad,
} from "../src/perception/audio/silero-vad";
import { createAudioService } from "../src/perception/audio/service";
import { createSnapshotStream } from "../src/http/snapshot-stream";
import { readAudioStream } from "../src/mijia/media/audio-stream";
import { petSoundPolicy } from "../src/perception/pet-sound/limits";
import { perceptionConfigSchema } from "../src/perception/config";

const { values } = parseArgs({
  options: {
    variant: { type: "string", default: "service" },
    sources: { type: "string", default: "1" },
    seconds: { type: "string", default: "30" },
    subscribers: { type: "string", default: "0" },
    "pet-sounds": { type: "boolean", default: false },
  },
});
const variant = z.enum(["ffmpeg", "libav", "service"]).parse(values.variant);
const count = z.coerce.number().int().min(1).max(8).parse(values.sources);
const seconds = z.coerce.number().int().min(5).max(3600).parse(values.seconds);
const subscribers = z.coerce
  .number()
  .int()
  .min(0)
  .max(16)
  .parse(values.subscribers);
if (subscribers && variant !== "service")
  throw new Error("SSE load belongs to the service variant");
const petSounds = values["pet-sounds"];
if (petSounds && variant !== "service")
  throw new Error("Pet sound load requires the production service variant");
const executable = process.env.PERCEPTION_FFMPEG_PATH ?? "ffmpeg";
const { stdout: versionOutput } = await promisify(execFile)(
  executable,
  ["-version"],
  { timeout: 3000 },
);
const environment = {
  bun: Bun.version,
  platform: process.platform,
  arch: process.arch,
  ffmpeg: versionOutput.split("\n")[0],
  nodeAvFfmpeg: ffmpegVersion(),
};
const source = await createAudioSource(count);
const config = perceptionConfigSchema.parse({
  sources: source.selected,
  petSounds: { enabled: petSounds },
});
const stop = new AbortController();
const errors: string[] = [];
const age = createHistogram();
const classificationAge = createHistogram();
const classifications = new Map<string, { endSample: number; count: number }>();
const loop = monitorEventLoopDelay({ resolution: 10 });
const decoded = Array.from({ length: count }, () => 0);
let pcmBatches = 0,
  notifications = 0,
  snapshots = 0,
  sseMessages = 0,
  sseBytes = 0;
const listeners = new Set<() => void>();
const service =
  variant === "service"
    ? createAudioService({
        sources: source.sources,
        media(track) {
          for (const chunk of track.petSounds?.chunks ?? []) {
            const previous = classifications.get(track.run.deviceId);
            if (previous && chunk.endSample <= previous.endSample) continue;
            classifications.set(track.run.deviceId, {
              endSample: chunk.endSample,
              count: (previous?.count ?? 0) + 1,
            });
            classificationAge.record(
              Math.max(
                1,
                Math.round((Date.now() - chunk.observedEndAt) * 1000),
              ),
            );
          }
        },
        executable,
        changed() {
          notifications++;
          for (const listener of listeners) listener();
        },
      })
    : undefined;
const decoders: (
  | ReturnType<typeof createAudioDecoder>
  | ReturnType<typeof createLibavAudioDecoder>
)[] = [];
let model: Awaited<ReturnType<typeof createVad>> | undefined;
let inference = Promise.resolve();
let reconcileTimer: ReturnType<typeof setInterval> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const readers: Promise<void>[] = [];
function record(error: unknown) {
  if (!stop.signal.aborted && errors.length < 20) errors.push(String(error));
}
try {
  if (service) {
    service.start();
    const reconcile = () => {
      service.reconcile(config, source.selected);
    };
    reconcile();
    reconcileTimer = setInterval(reconcile, 500);
    const app = new Hono().get(
      "/stream",
      createSnapshotStream(
        {
          subscribe(listener) {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        },
        () => {
          snapshots++;
          return service.snapshot();
        },
        stop.signal,
      ),
    );
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: app.fetch,
      idleTimeout: 0,
    });
    for (let index = 0; index < subscribers; index++) {
      const response = await fetch(`${server.url.toString()}stream`, {
        signal: stop.signal,
      });
      const stream = response
        .body!.pipeThrough(new TextDecoderStream())
        .pipeThrough(new EventSourceParserStream());
      readers.push(
        (async () => {
          for await (const event of stream) {
            if (event.event === "snapshot") {
              sseMessages++;
              sseBytes += Buffer.byteLength(event.data);
            }
            if (index === subscribers - 1 && subscribers > 1)
              await delay(2000, undefined, { signal: stop.signal });
          }
        })().catch(record),
      );
    }
  } else {
    model = await createVad();
    const shared = model;
    const evaluate = (input: Float32Array, state: Float32Array) => {
      const task = inference.then(() => shared.evaluate(input, state));
      inference = task.then(() => {}, record);
      return task;
    };
    for (const [index, selected] of source.selected.entries()) {
      const prepared = await source.sources.prepare(selected, stop.signal);
      const analysis = createAudioAnalysis(createSileroTrack(evaluate));
      const create =
        variant === "ffmpeg" ? createAudioDecoder : createLibavAudioDecoder;
      const decoder = create({
        config,
        executable,
        open: (signal) => readAudioStream(prepared.access, signal),
        onMedia() {},
        async onPcm(pcm, observedAt) {
          await analysis.accept(pcm);
          decoded[index]! += pcm.length;
          pcmBatches++;
          age.record(Math.max(1, Math.round((Date.now() - observedAt) * 1000)));
        },
      });
      decoder.completed.catch(record);
      decoders.push(decoder);
    }
  }
  if (petSounds && service) {
    const deadline = performance.now() + config.firstFrameTimeoutMs;
    while (true) {
      const tracks = service.snapshot().tracks;
      if (tracks.some((track) => track.petSounds?.status === "unavailable"))
        throw new Error("Pet sound classification unavailable during warm-up");
      if (
        tracks.length === count &&
        tracks.every(
          (track) =>
            track.validity === "valid" && track.petSounds?.status === "ready",
        )
      )
        break;
      if (performance.now() >= deadline)
        throw new Error("Audio classification warm-up timed out");
      await delay(100);
    }
  } else await delay(5000);
  const totals = () => {
    const tracks = service?.snapshot().tracks;
    return tracks
      ? source.selected.map(
          ({ deviceId }) =>
            tracks.find((track) => track.run.deviceId === deviceId)?.samples ??
            0,
        )
      : [...decoded];
  };
  const before = totals();
  const classificationsBefore = source.selected.map(
    ({ deviceId }) => classifications.get(deviceId)?.count ?? 0,
  );
  classificationAge.reset();
  const resourceSampler = createAudioResourceSampler();
  const resourceStart = await resourceSampler.sample();
  let resourceEnd = resourceStart;
  let maxRss = resourceStart.rssMiB;
  let maxProcesses = resourceStart.processes;
  const started = performance.now();
  const initialEvents = {
    pcmBatches,
    notifications,
    snapshots,
    sseMessages,
    sseBytes,
  };
  const initialRuns = new Set(
    service?.snapshot().tracks.map((track) => track.run.trackRunId),
  );
  let invalid = 0;
  loop.enable();
  for (let second = 0; second < seconds; second++) {
    await delay(Math.max(0, started + (second + 1) * 1000 - performance.now()));
    resourceEnd = await resourceSampler.sample();
    maxRss = Math.max(maxRss, resourceEnd.rssMiB);
    maxProcesses = Math.max(maxProcesses, resourceEnd.processes);
    if (service) {
      const tracks = service.snapshot().tracks;
      if (
        tracks.length !== count ||
        tracks.some(
          (track) =>
            track.validity !== "valid" ||
            !initialRuns.has(track.run.trackRunId) ||
            (petSounds && track.petSounds?.status !== "ready"),
        )
      )
        invalid++;
      for (const track of tracks)
        if (track.observedAt !== null)
          age.record(
            Math.max(1, Math.round((Date.now() - track.observedAt) * 1000)),
          );
    }
    if ((second + 1) % 60 === 0)
      console.error(
        JSON.stringify({
          progressSeconds: second + 1,
          variant,
          sources: count,
          rssMiB: resourceEnd.rssMiB,
          invalid,
          errors,
        }),
      );
  }
  loop.disable();
  const elapsedMs = performance.now() - started;
  const after = totals();
  const classificationDeltas = source.selected.map(
    ({ deviceId }, index) =>
      (classifications.get(deviceId)?.count ?? 0) -
      classificationsBefore[index]!,
  );
  if (
    errors.length ||
    invalid ||
    (petSounds &&
      classificationDeltas.some(
        (value) =>
          value <
          Math.max(1, Math.floor((seconds * 1000) / petSoundPolicy.hopMs) - 1),
      )) ||
    after.some(
      (value, index) => value - before[index]! < seconds * 16000 * 0.95,
    )
  )
    process.exitCode = 1;
  console.log(
    JSON.stringify({
      variant,
      environment,
      sources: count,
      subscribers,
      petSounds,
      classificationDeltas,
      classificationDeliveryAgeMs: petSounds
        ? {
            p50: classificationAge.percentile(50) / 1000,
            p95: classificationAge.percentile(95) / 1000,
            p99: classificationAge.percentile(99) / 1000,
          }
        : null,
      seconds,
      elapsedMs,
      sourceFormat: "PCMA 8kHz mono",
      sampleDeltas: after.map((value, index) => value - before[index]!),
      cpuPercentOfOneCore:
        ((resourceEnd.cpuMs - resourceStart.cpuMs) / elapsedMs) * 100,
      rssMiB: {
        start: resourceStart.rssMiB,
        end: resourceEnd.rssMiB,
        max: maxRss,
        growth: resourceEnd.rssMiB - resourceStart.rssMiB,
      },
      maxProcesses,
      ageMs: {
        p50: age.percentile(50) / 1000,
        p95: age.percentile(95) / 1000,
        p99: age.percentile(99) / 1000,
      },
      eventLoopP99Ms: loop.percentile(99) / 1e6,
      pcmBatches: pcmBatches - initialEvents.pcmBatches,
      notifications: notifications - initialEvents.notifications,
      snapshots: snapshots - initialEvents.snapshots,
      sseMessages: sseMessages - initialEvents.sseMessages,
      sseBytes: sseBytes - initialEvents.sseBytes,
      invalidSeconds: invalid,
      errors,
    }),
  );
} finally {
  stop.abort();
  clearInterval(reconcileTimer);
  loop.disable();
  const closed = await Promise.allSettled([
    service?.close(),
    ...decoders.map((decoder) => decoder.close()),
    ...readers,
    server?.stop(true),
    source.close(),
  ]);
  closed.push(
    ...(await Promise.allSettled([inference.then(() => model?.close())])),
  );
  const failures = closed
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length) {
    process.exitCode = 1;
    console.error(
      new AggregateError(failures, "Audio benchmark cleanup failed"),
    );
  }
}
