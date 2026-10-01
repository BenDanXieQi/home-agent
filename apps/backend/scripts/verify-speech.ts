import { createSpeechRoutes } from "../src/conversation/routes";
import { createSpeechInbox } from "../src/conversation/speech-inbox";
import { parseArgs } from "node:util";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  speechObservationSchema,
  perceptionSnapshotSchema,
} from "@home-agent/api/contracts";
import { createAudioSource } from "./perception-evaluation/audio-source";
import { audioResources } from "./perception-evaluation/audio-resources";
import { createAudioService } from "../src/perception/audio/service";
import { createPerceptionService } from "../src/perception/service";
import { createPerceptionRoutes } from "../src/perception/routes";
import { perceptionConfigSchema } from "../src/perception/config";

const { values } = parseArgs({
  options: {
    audio: { type: "string" },
    output: { type: "string" },
    seconds: { type: "string", default: "30" },
    sources: { type: "string", default: "1" },
    video: { type: "boolean", default: false },
    lifecycle: { type: "boolean", default: false },
    "expect-silence": { type: "boolean", default: false },
    "dual-channel": { type: "boolean", default: false },
  },
});
const input = z
  .object({
    audio: z.string().min(1),
    output: z.string().min(1),
    seconds: z.coerce.number().int().min(15).max(3600),
    sources: z.coerce.number().int().min(1).max(8),
    video: z.boolean(),
    lifecycle: z.boolean(),
    "expect-silence": z.boolean(),
    "dual-channel": z.boolean(),
  })
  .parse(values);
if (input.lifecycle && (input.seconds < 110 || input["expect-silence"]))
  throw new Error("Lifecycle scenario needs speech and at least 110 seconds");
if (input["dual-channel"] && input.sources > 4)
  throw new Error("At most eight video channels are allowed");
const output = resolve(input.output);
await mkdir(dirname(output), { recursive: true });
const journal = output + ".jsonl";
await writeFile(journal, "");
const bytes = new Uint8Array(await readFile(input.audio));
const source = await createAudioSource(input.sources, {
  speech: bytes,
  video: input.video,
});
if (input["expect-silence"])
  for (const device of source.selected)
    source.modes.set(device.deviceId, "quiet");
const selected = input["dual-channel"]
  ? source.selected.flatMap((device) => [
      device,
      { ...device, channel: 2 as const },
    ])
  : source.selected;
const config = perceptionConfigSchema.parse({
  sources: selected,
  cpuRatio: 0.5,
  firstFrameTimeoutMs: 10000,
  silenceTimeoutMs: 3000,
  maxFrameAgeMs: 2000,
  speech: { enabled: true, idleUnloadMs: 5000 },
});
const speechInbox = createSpeechInbox({ instanceId: crypto.randomUUID() });
speechInbox.configure(config.dialogue);
const stopping = new AbortController();
process.once("SIGINT", () => {
  stopping.abort();
});
process.once("SIGTERM", () => {
  stopping.abort();
});
const errors: string[] = [];
const records: z.infer<typeof speechObservationSchema>[] = [];
const seen = new Set<string>();
const resources: (Awaited<ReturnType<typeof audioResources>> & {
  elapsed: number;
})[] = [];
const observedProcesses = new Map<
  number,
  Awaited<ReturnType<typeof audioResources>>["members"][number]
>();
async function sampleResources() {
  const snapshot = await audioResources(observedProcesses);
  for (const member of snapshot.members) observedProcesses.set(member.pid, member);
  return snapshot;
}
const actions: { kind: string; elapsed: number; detail?: unknown }[] = [];
let videoFrames = 0,
  httpSnapshots = 0;
let topology = false,
  unloaded = false,
  wokeAgain = false,
  cancelledScope = false,
  recoveredModel = false;
let stalled = false,
  restored = false,
  revoked = false,
  granted = false,
  frozen = false,
  quiet = false,
  resumed = false;
let revokedAt = 0,
  sleepingLoads = 0,
  frozenFailures = 0;
let frozenCheckpoint: ReturnType<typeof speechCheckpoint> | undefined;
let resumedCheckpoint: ReturnType<typeof speechCheckpoint> | undefined;
let firstRunId: string | undefined,
  newRunAfterStall = false;
let quietAudioId: number | undefined,
  captureContinuous = false;
const quietRuns = new Map<string, { runId: string; samples: number }>();
let revokedScope: string | undefined;
let lastHandoff: ReturnType<typeof speechInbox.snapshot> | undefined;
let lastSnapshot:
  | ReturnType<ReturnType<typeof createAudioService>["snapshot"]>
  | undefined;
const configPath = output + ".config.json";
let cleanup: Awaited<ReturnType<typeof audioResources>> | undefined;
let started = 0;
function speechCheckpoint(
  view: ReturnType<ReturnType<typeof createAudioService>["snapshot"]>,
) {
  return {
    at: Date.now(),
    completed: view.speech?.completed ?? 0,
    samples: new Map(
      view.tracks.map((track) => [track.run.trackRunId, track.samples]),
    ),
  };
}
function hasNewSpeech(
  view: ReturnType<ReturnType<typeof createAudioService>["snapshot"]>,
  checkpoint: ReturnType<typeof speechCheckpoint>,
) {
  return (
    view.speech !== undefined &&
    view.speech.completed > checkpoint.completed &&
    view.tracks.some((track) => {
      const before = checkpoint.samples.get(track.run.trackRunId);
      const result = track.speech?.latest;
      return (
        before !== undefined &&
        result !== undefined &&
        result !== null &&
        track.speech?.validity === "valid" &&
        result.completedAt >= checkpoint.at &&
        result.speechEndSample > before
      );
    })
  );
}
async function createService() {
  if (input.video) {
    await writeFile(configPath, JSON.stringify(config));
    const service = createPerceptionService({
      speechInbox,
      configPath,
      executable: "ffmpeg",
      sources: source.sources,
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 503 }),
    });
    if (!server.port) throw new Error("Unable to bind verification endpoint");
    const app = createPerceptionRoutes(
      service,
      server.port,
      stopping.signal,
      30000,
    );
    app.route(
      "/speech",
      createSpeechRoutes(speechInbox, server.port, stopping.signal),
    );
    server.reload({ fetch: app.fetch });
    await service.start();
    return {
      audio: () => service.snapshot().audio,
      async sampleHttp() {
        const response = await fetch(server.url, {
          signal: AbortSignal.timeout(2000),
        });
        if (!response.ok) throw new Error(`Perception HTTP ${response.status}`);
        const view = perceptionSnapshotSchema.parse(await response.json());
        httpSnapshots++;
        videoFrames = view.sources.reduce(
          (sum, item) => sum + (item.metrics.succeeded ?? 0),
          0,
        );
      },
      async close() {
        await service.close();
        await server.stop(true);
      },
    };
  }
  const service = createAudioService({
    speechInbox,
    sources: source.sources,
    executable: "ffmpeg",
    changed() {},
  });
  service.start();
  const reconcile = () => {
    service.reconcile(config, selected);
  };
  const timer = setInterval(reconcile, 50);
  reconcile();
  return {
    audio: () => service.snapshot(),
    sampleHttp: () => Promise.resolve(),
    async close() {
      clearInterval(timer);
      await service.close();
    },
  };
}
let service: Awaited<ReturnType<typeof createService>> | undefined;
try {
  service = await createService();
  started = performance.now();
  let nextResourceAt = 0;
  while (
    !stopping.signal.aborted &&
    performance.now() - started < input.seconds * 1000
  ) {
    const elapsed = (performance.now() - started) / 1000;
    const view = service.audio();
    lastSnapshot = view;
    const first = view.tracks.find(
      (track) => track.run.deviceId === source.selected[0]!.deviceId,
    );
    firstRunId ??= first?.run.trackRunId;
    if (
      restored &&
      first &&
      first.run.trackRunId !== firstRunId &&
      first.samples > 8000
    )
      newRunAfterStall = true;
    for (const track of view.tracks) {
      const result = track.speech?.latest;
      if (result && !seen.has(result.id)) {
        if (result.run.scopeEpoch === revokedScope)
          errors.push("A revoked scope published a new transcription");
        seen.add(result.id);
        records.push(result);
        await appendFile(journal, JSON.stringify({ result }) + "\n");
      }
    }
    if (input.lifecycle) {
      if (elapsed >= 12 && !stalled) {
        stalled = true;
        source.modes.set(source.selected[0]!.deviceId, "stalled");
        actions.push({ kind: "stall", elapsed });
      }
      if (elapsed >= 17 && !restored) {
        restored = true;
        source.modes.set(source.selected[0]!.deviceId, "speech");
        actions.push({ kind: "restore", elapsed });
      }
      if (
        elapsed >= 30 &&
        !revoked &&
        view.tracks.some((track) => track.speech?.status === "recognizing")
      ) {
        revoked = true;
        revokedAt = elapsed;
        revokedScope = first?.run.scopeEpoch;
        source.revoke();
        cancelledScope = service.audio().tracks.length === 0;
        actions.push({ kind: "revoke", elapsed, detail: view.speech });
      }
      if (revoked && elapsed - revokedAt >= 5 && !granted) {
        granted = true;
        source.grant();
        actions.push({ kind: "grant", elapsed });
      }
      if (
        elapsed >= 50 &&
        !frozen &&
        view.speech?.processId &&
        view.tracks.some((track) => track.speech?.status === "recognizing")
      ) {
        const owned = await sampleResources();
        const child = owned.members.find(
          (member) => member.pid === view.speech!.processId,
        );
        if (
          child &&
          child.parent === view.processId &&
          child.group === view.processId
        ) {
          frozen = true;
          frozenFailures = view.speech.failures;
          frozenCheckpoint = speechCheckpoint(service.audio());
          process.kill(child.pid, "SIGSTOP");
          actions.push({ kind: "freeze_asr", elapsed, detail: child });
        }
      }
      if (
        frozenCheckpoint &&
        view.speech &&
        view.speech.failures > frozenFailures &&
        hasNewSpeech(view, frozenCheckpoint)
      )
        recoveredModel = true;
      if (elapsed >= 72 && !quiet) {
        quiet = true;
        quietAudioId = view.processId;
        for (const track of view.tracks)
          quietRuns.set(track.run.deviceId, {
            runId: track.run.trackRunId,
            samples: track.samples,
          });
        for (const device of source.selected)
          source.modes.set(device.deviceId, "quiet");
        actions.push({ kind: "quiet", elapsed });
      }
      if (
        quiet &&
        !resumed &&
        view.speech?.status === "sleeping" &&
        view.speech.processId === undefined
      ) {
        if (!unloaded)
          actions.push({ kind: "unloaded", elapsed, detail: view.speech });
        unloaded = true;
        sleepingLoads = view.speech.loads;
      }
      if (elapsed >= 87 && !resumed) {
        resumed = true;
        resumedCheckpoint = speechCheckpoint(view);
        for (const device of source.selected)
          source.modes.set(device.deviceId, "speech");
        actions.push({ kind: "resume_speech", elapsed });
      }
      if (
        resumedCheckpoint &&
        view.speech &&
        view.speech.loads > sleepingLoads &&
        hasNewSpeech(view, resumedCheckpoint)
      ) {
        wokeAgain = true;
        captureContinuous =
          view.processId === quietAudioId &&
          view.tracks.length === input.sources &&
          view.tracks.every((track) => {
            const before = quietRuns.get(track.run.deviceId);
            return (
              before &&
              before.runId === track.run.trackRunId &&
              track.samples > before.samples
            );
          });
      }
    }
    if (elapsed >= nextResourceAt) {
      const resource = await sampleResources();
      resources.push({ elapsed, ...resource });
      const asr = resource.members.find(
        (member) => member.pid === view.speech?.processId,
      );
      const owner = resource.members.find(
        (member) => member.pid === view.processId,
      );
      if (
        asr &&
        owner &&
        asr.parent === owner.pid &&
        owner.parent === process.pid &&
        asr.group === owner.pid
      )
        topology = true;
      await service.sampleHttp();
      console.log(
        JSON.stringify({
          elapsed: Math.round(elapsed),
          parent: process.pid,
          audio: view.processId,
          asr: view.speech,
          tracks: view.tracks.map((track) => ({
            deviceId: track.run.deviceId,
            samples: track.samples,
            status: track.status,
            speech: track.speech?.status,
          })),
          results: records.length,
          rssMiB: resource.rssMiB,
          videoFrames,
        }),
      );
      nextResourceAt += 5;
    }
    await delay(25);
  }
  lastSnapshot = service.audio();
  lastHandoff = speechInbox.snapshot();
} catch (error) {
  errors.push(String(error));
} finally {
  stopping.abort();
  try {
    await sampleResources();
  } catch (error) {
    errors.push(String(error));
  }
  try {
    await service?.close();
  } catch (error) {
    errors.push(String(error));
  }
  try {
    await source.close();
  } catch (error) {
    errors.push(String(error));
  }
  await speechInbox.close();
  cleanup = await sampleResources();
}
const latencies = records
  .map((item) => item.completedAt - item.observedEndAt)
  .toSorted((a, b) => a - b);
const conditions = {
  noUnexpectedErrors: errors.length === 0,
  sourceProgress:
    lastSnapshot?.tracks.length === input.sources &&
    lastSnapshot.tracks.every((track) => track.samples > 8000),
  speechResults: input["expect-silence"]
    ? records.length === 0
    : source.selected.every((device) =>
        records.some((item) => item.run.deviceId === device.deviceId),
      ),
  processTopology: input["expect-silence"]
    ? lastSnapshot?.speech?.loads === 0
    : topology,
  asrAvailable:
    lastSnapshot?.speech !== undefined &&
    lastSnapshot.speech.status !== "unavailable",
  captureContinuous: !input.lifecycle || captureContinuous,
  idleRelease: !input.lifecycle || unloaded,
  wakeAgain: !input.lifecycle || wokeAgain,
  sourceRecovery: !input.lifecycle || newRunAfterStall,
  scopeRevocation: !input.lifecycle || (revoked && granted && cancelledScope),
  asrRecovery: !input.lifecycle || (frozen && recoveredModel),
  video: !input.video || (httpSnapshots > 0 && videoFrames > 0),
  cleanup: cleanup.processes === 1,
};
const report = {
  input,
  config,
  conditions,
  handoff: lastHandoff,
  passed: Object.values(conditions).every(Boolean),
  errors,
  parentPid: process.pid,
  actions,
  records,
  lastSnapshot,
  resources,
  observedProcesses: [...observedProcesses.values()],
  cleanup,
  httpSnapshots,
  videoFrames,
  latencyMs: {
    count: latencies.length,
    p95: latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] ?? null,
    max: latencies.at(-1) ?? null,
  },
  limitations: [
    "Controlled A-law speech and synthetic video, not real camera recordings",
    "Idle timeout set to 5 seconds for lifecycle verification; production default is 60 seconds",
    "Orphan detection retains observed PID, process group and ps start time; start times have one-second precision",
    "Processes that became orphaned before their ownership was sampled cannot be attributed to this run",
  ],
};
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({ passed: report.passed, conditions, errors, output }),
);
if (!report.passed) process.exitCode = 1;
