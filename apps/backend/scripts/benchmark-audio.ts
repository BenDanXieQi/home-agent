import { parseArgs, promisify } from "node:util";
import { execFile } from "node:child_process";
import { ffmpegVersion } from "node-av/ffmpeg";
import { setTimeout as delay } from "node:timers/promises";
import { createHistogram, monitorEventLoopDelay } from "node:perf_hooks";
import { Hono } from "hono";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { z } from "zod";
import { createAudioSource } from "./perception-evaluation/audio-source";
import { audioResources } from "./perception-evaluation/audio-resources";
import { createLibavAudioDecoder } from "./perception-evaluation/audio-libav";
import { createAudioDecoder } from "../src/perception/audio/decoder";
import { createAudioAnalysis } from "../src/perception/audio/analysis";
import {
  createSileroTrack,
  createVad,
} from "../src/perception/audio/silero-vad";
import { createAudioService } from "../src/perception/audio/service";
import { createPerceptionStream } from "../src/perception/stream";
import { readAudioStream } from "../src/mijia/media/audio-stream";
import { perceptionConfigSchema } from "../src/perception/config";

const { values } = parseArgs({
  options: {
    variant: { type: "string", default: "service" },
    sources: { type: "string", default: "1" },
    seconds: { type: "string", default: "30" },
    subscribers: { type: "string", default: "0" },
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
const config = perceptionConfigSchema.parse({ sources: source.selected });
const stop = new AbortController();
const errors: string[] = [];
const age = createHistogram();
const loop = monitorEventLoopDelay({ resolution: 10 });
const decoded = Array.from({ length: count }, () => 0);
let pcmBatches = 0,
  notifications = 0,
  snapshots = 0,
  sseMessages = 0,
  sseBytes = 0;
const listeners = new Set<() => void>();
const service = createAudioService({
  sources: source.sources,
  executable: process.env.PERCEPTION_FFMPEG_PATH ?? "ffmpeg",
  changed() {
    notifications++;
    for (const listener of listeners) listener();
  },
});
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
  if (variant === "service") {
    service.start();
    const reconcile = () => {
      service.reconcile(config, source.selected);
    };
    reconcile();
    reconcileTimer = setInterval(reconcile, 500);
    const app = new Hono().get(
      "/stream",
      createPerceptionStream(
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
        executable: process.env.PERCEPTION_FFMPEG_PATH ?? "ffmpeg",
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
  await delay(5000);
  const totals = () =>
    variant === "service"
      ? source.selected.map(
          (selected) =>
            service
              .snapshot()
              .tracks.find((track) => track.run.deviceId === selected.deviceId)
              ?.samples ?? 0,
        )
      : [...decoded];
  const before = totals();
  const resourceStart = await audioResources();
  const resources = [resourceStart];
  const started = performance.now();
  const initialEvents = {
    pcmBatches,
    notifications,
    snapshots,
    sseMessages,
    sseBytes,
  };
  const initialRuns = service
    .snapshot()
    .tracks.map((track) => track.run.trackRunId);
  let invalid = 0;
  loop.enable();
  for (let second = 0; second < seconds; second++) {
    await delay(Math.max(0, started + (second + 1) * 1000 - performance.now()));
    resources.push(await audioResources());
    if (variant === "service") {
      const tracks = service.snapshot().tracks;
      if (
        tracks.length !== count ||
        tracks.some(
          (track) =>
            track.validity !== "valid" ||
            !initialRuns.includes(track.run.trackRunId),
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
          rssMiB: resources.at(-1)!.rssMiB,
          invalid,
          errors,
        }),
      );
  }
  loop.disable();
  const elapsedMs = performance.now() - started;
  const after = totals();
  const end = resources.at(-1)!;
  if (
    errors.length ||
    invalid ||
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
      seconds,
      elapsedMs,
      sourceFormat: "PCMA 8kHz mono",
      sampleDeltas: after.map((value, index) => value - before[index]!),
      cpuPercentOfOneCore:
        ((end.cpuMs - resourceStart.cpuMs) / elapsedMs) * 100,
      rssMiB: {
        start: resourceStart.rssMiB,
        end: end.rssMiB,
        max: Math.max(...resources.map((row) => row.rssMiB)),
        growth: end.rssMiB - resourceStart.rssMiB,
      },
      maxProcesses: Math.max(...resources.map((row) => row.processes)),
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
  await Promise.all([
    service.close(),
    ...decoders.map((decoder) => decoder.close()),
  ]);
  await Promise.all(readers);
  await server?.stop(true);
  await model?.close();
  await source.close();
}
