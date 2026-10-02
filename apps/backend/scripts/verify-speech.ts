import { createSpeechRoutes } from "../src/conversation/routes";
import { createSpeechInbox } from "../src/conversation/speech-inbox";
import { parseArgs } from "node:util";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { Hono } from "hono";
import { speechInboxSchema } from "@home-agent/api/speech-dialogue";
import { perceptionSnapshotSchema } from "@home-agent/api/contracts";
import { speechLimits } from "../src/perception/speech/limits";
import { createAudioSource } from "./perception-evaluation/audio-source";
import { createAudioResourceSampler } from "./perception-evaluation/audio-resources";
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
const resourceSampler = createAudioResourceSampler();
const sampleResources = resourceSampler.sample;
const resources: (Awaited<ReturnType<typeof sampleResources>> & {
  elapsed: number;
})[] = [];
const deliveries: {
  observation: Parameters<typeof speechInbox.accept>[0];
  accepted: boolean;
  expectedRejection: boolean;
}[] = [];
const actions = new Map<string, { elapsed: number; detail?: unknown }>();
let videoFrames = 0,
  httpSnapshots = 0,
  speechHttpSnapshots = 0;
let topology = false,
  wokeAgain = false,
  cancelledScope = false,
  recoveredModel = false;
let sleepingLoads = 0,
  frozenFailures = 0;
let frozenCheckpoint: ReturnType<typeof speechCheckpoint> | undefined;
let resumedCheckpoint: ReturnType<typeof speechCheckpoint> | undefined;
let firstRunId: string | undefined,
  newRunAfterStall = false;
let quietCheckpoint: ReturnType<typeof speechCheckpoint> | undefined;
let captureContinuous = false;
let revocationHandoff:
  | {
      scopeEpoch: string;
      runIds: string[];
      startedAt: number;
      endedAt?: number;
      rejectedBefore: number;
      rejectedAfter?: number;
    }
  | undefined;
let lastHandoff: ReturnType<typeof speechInbox.snapshot> | undefined;
let lastSnapshot:
  | ReturnType<ReturnType<typeof createAudioService>["snapshot"]>
  | undefined;
const configPath = output + ".config.json";
let cleanup: Awaited<ReturnType<typeof sampleResources>> | undefined;
let started = 0;
let journalIndex = 0;
const observedInbox = {
  ...speechInbox,
  accept(observation: Parameters<typeof speechInbox.accept>[0]) {
    const accepted = speechInbox.accept(observation);
    const expectedRejection =
      !accepted &&
      input.lifecycle &&
      ((revocationHandoff?.scopeEpoch === observation.run.scopeEpoch &&
        revocationHandoff.runIds.includes(observation.run.trackRunId)) ||
        (actions.has("stall") && observation.run.trackRunId === firstRunId));
    deliveries.push({ observation, accepted, expectedRejection });
    if (
      accepted &&
      observation.run.scopeEpoch === revocationHandoff?.scopeEpoch
    )
      errors.push("A revoked scope delivered a new transcription");
    return accepted;
  },
};
async function flushJournal() {
  while (journalIndex < deliveries.length) {
    await appendFile(
      journal,
      JSON.stringify({ result: deliveries[journalIndex]!.observation }) + "\n",
    );
    journalIndex++;
  }
}
function speechCheckpoint(
  view: ReturnType<ReturnType<typeof createAudioService>["snapshot"]>,
) {
  return {
    at: Date.now(),
    deliveryCount: deliveries.length,
    processId: view.processId,
    runs: view.tracks.map(({ run, samples }) => ({
      deviceId: run.deviceId,
      runId: run.trackRunId,
      samples,
    })),
  };
}
function hasNewSpeech(
  view: ReturnType<ReturnType<typeof createAudioService>["snapshot"]>,
  checkpoint: ReturnType<typeof speechCheckpoint>,
) {
  return deliveries.some(({ observation, accepted }, index) => {
    const before = checkpoint.runs.find(
      (run) => run.runId === observation.run.trackRunId,
    );
    return (
      index >= checkpoint.deliveryCount &&
      accepted &&
      before !== undefined &&
      observation.completedAt >= checkpoint.at &&
      observation.speechEndSample > before.samples &&
      Date.now() - observation.observedEndAt < speechLimits.resultAgeMs &&
      view.tracks.some(
        (track) =>
          track.run.trackRunId === observation.run.trackRunId &&
          track.speech?.validity === "valid",
      )
    );
  });
}
async function createService() {
  const options = {
    speechInbox: observedInbox,
    sources: source.sources,
    executable: "ffmpeg",
  };
  const capture = input.video
    ? createPerceptionService({ ...options, configPath })
    : createAudioService({ ...options, changed() {} });
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  async function close() {
    clearInterval(reconcileTimer);
    try {
      await capture.close();
    } finally {
      await server?.stop(true);
    }
  }
  try {
    if ("reconcile" in capture) {
      capture.start();
      const reconcile = () => capture.reconcile(config, selected);
      reconcileTimer = setInterval(reconcile, 50);
      reconcile();
    } else {
      await writeFile(configPath, JSON.stringify(config));
      await capture.start();
    }
    const app = new Hono();
    const endpoint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: app.fetch,
    });
    server = endpoint;
    const port = endpoint.port;
    if (!port) throw new Error("Unable to bind verification endpoint");
    app.route(
      "/speech",
      createSpeechRoutes(speechInbox, port, stopping.signal),
    );
    if (!("reconcile" in capture))
      app.route(
        "/",
        createPerceptionRoutes(capture, port, stopping.signal, 30000),
      );
    return {
      audio: () =>
        "reconcile" in capture ? capture.snapshot() : capture.snapshot().audio,
      async sampleHttp() {
        const speechResponse = await fetch(new URL("speech", endpoint.url), {
          signal: AbortSignal.timeout(2000),
        });
        if (!speechResponse.ok)
          throw new Error(`Speech HTTP ${speechResponse.status}`);
        speechInboxSchema.parse(await speechResponse.json());
        speechHttpSnapshots++;
        if (!input.video) return;
        const response = await fetch(endpoint.url, {
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
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Verification startup failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
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
      actions.has("restore") &&
      first &&
      first.run.trackRunId !== firstRunId &&
      first.samples > 8000
    )
      newRunAfterStall = true;
    await flushJournal();
    if (input.lifecycle) {
      if (elapsed >= 12 && !actions.has("stall")) {
        source.modes.set(source.selected[0]!.deviceId, "stalled");
        actions.set("stall", { elapsed });
      }
      if (elapsed >= 17 && !actions.has("restore")) {
        source.modes.set(source.selected[0]!.deviceId, "speech");
        actions.set("restore", { elapsed });
      }
      if (
        elapsed >= 30 &&
        !actions.has("revoke") &&
        first &&
        speechInbox
          .snapshot()
          .entries.some(
            (entry) =>
              entry.observation.run.scopeEpoch === first.run.scopeEpoch,
          ) &&
        view.tracks.some((track) => track.speech?.status === "recognizing")
      ) {
        const before = speechInbox.snapshot();
        revocationHandoff = {
          scopeEpoch: first.run.scopeEpoch,
          runIds: view.tracks.map((track) => track.run.trackRunId),
          startedAt: elapsed,
          rejectedBefore: view.speech?.inboxUnconfirmed ?? 0,
        };
        source.revoke();
        const after = speechInbox.snapshot();
        cancelledScope =
          service.audio().tracks.length === 0 &&
          after.entries.every(
            (entry) =>
              entry.observation.run.scopeEpoch !== first.run.scopeEpoch,
          );
        actions.set("revoke", {
          elapsed,
          detail: { speech: view.speech, before, after },
        });
      }
      if (
        revocationHandoff &&
        elapsed - revocationHandoff.startedAt >= 5 &&
        !actions.has("grant")
      ) {
        revocationHandoff.endedAt = elapsed;
        revocationHandoff.rejectedAfter = view.speech?.inboxUnconfirmed ?? 0;
        source.grant();
        actions.set("grant", { elapsed });
      }
      if (
        elapsed >= 50 &&
        !actions.has("freeze_asr") &&
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
          frozenFailures = view.speech.failures;
          frozenCheckpoint = speechCheckpoint(service.audio());
          process.kill(child.pid, "SIGSTOP");
          actions.set("freeze_asr", { elapsed, detail: child });
        }
      }
      if (
        frozenCheckpoint &&
        view.speech &&
        view.speech.failures > frozenFailures &&
        hasNewSpeech(view, frozenCheckpoint)
      )
        recoveredModel = true;
      if (elapsed >= 72 && !actions.has("quiet")) {
        quietCheckpoint = speechCheckpoint(view);
        for (const device of source.selected)
          source.modes.set(device.deviceId, "quiet");
        actions.set("quiet", { elapsed });
      }
      if (
        actions.has("quiet") &&
        !actions.has("resume_speech") &&
        view.speech?.status === "sleeping" &&
        view.speech.processId === undefined
      ) {
        if (!actions.has("unloaded"))
          actions.set("unloaded", { elapsed, detail: view.speech });
        sleepingLoads = view.speech.loads;
      }
      if (elapsed >= 87 && !actions.has("resume_speech")) {
        resumedCheckpoint = speechCheckpoint(view);
        for (const device of source.selected)
          source.modes.set(device.deviceId, "speech");
        actions.set("resume_speech", { elapsed });
      }
      if (
        resumedCheckpoint &&
        view.speech &&
        view.speech.loads > sleepingLoads &&
        hasNewSpeech(view, resumedCheckpoint)
      ) {
        wokeAgain = true;
        const quiet = quietCheckpoint;
        captureContinuous =
          quiet !== undefined &&
          view.processId === quiet.processId &&
          view.tracks.length === input.sources &&
          view.tracks.every((track) => {
            const before = quiet.runs.find(
              (run) => run.deviceId === track.run.deviceId,
            );
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
          deliveries: deliveries.length,
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
  await flushJournal();
} catch (error) {
  errors.push(String(error));
} finally {
  stopping.abort();
  try {
    await sampleResources();
  } catch (error) {
    errors.push(String(error));
  }
  const closed = await Promise.allSettled([service?.close(), source.close()]);
  for (const result of closed)
    if (result.status === "rejected") errors.push(String(result.reason));
  lastHandoff = speechInbox.snapshot();
  await speechInbox.close();
  cleanup = await sampleResources();
}
await flushJournal();
const latencies = deliveries
  .map(({ observation }) => observation.completedAt - observation.observedEndAt)
  .toSorted((a, b) => a - b);
if (
  new Set(deliveries.map(({ observation }) => observation.id)).size !==
  deliveries.length
)
  errors.push("A transcription was delivered more than once");
const rejectedDeliveries = deliveries.filter(({ accepted }) => !accepted);
const acceptedCount = deliveries.length - rejectedDeliveries.length;
// During this window every source is withdrawn, so a late handoff can only
// belong to the recorded revoked runs. The 1-second handoff deadline ends
// before the script grants a new scope after at least 5 seconds.
const revokedHandoffRejections =
  revocationHandoff?.rejectedAfter !== undefined
    ? revocationHandoff.rejectedAfter - revocationHandoff.rejectedBefore
    : 0;
const conditions = {
  noUnexpectedErrors: errors.length === 0,
  sourceProgress:
    lastSnapshot?.tracks.length === input.sources &&
    lastSnapshot.tracks.every((track) => track.samples > 8000),
  segmentHandoff: input["expect-silence"]
    ? deliveries.length === 0
    : source.selected.every((device) =>
        deliveries.some(
          ({ observation, accepted }) =>
            observation.run.deviceId === device.deviceId && accepted,
        ),
      ),
  handoffCounters:
    lastHandoff !== undefined &&
    lastHandoff.sequence === acceptedCount &&
    lastHandoff.rejected === rejectedDeliveries.length &&
    rejectedDeliveries.every((attempt) => attempt.expectedRejection) &&
    (lastSnapshot?.speech?.inboxUnconfirmed ?? Infinity) ===
      rejectedDeliveries.length + revokedHandoffRejections,
  speechHttp: speechHttpSnapshots > 0,
  cumulativeCpu:
    resources.length > 1 &&
    resources.every(
      (resource, index) =>
        index === 0 || resource.cpuMs >= resources[index - 1]!.cpuMs,
    ),
  processTopology: input["expect-silence"]
    ? lastSnapshot?.speech?.loads === 0
    : topology,
  asrAvailable:
    lastSnapshot?.speech !== undefined &&
    lastSnapshot.speech.status !== "unavailable",
  captureContinuous: !input.lifecycle || captureContinuous,
  idleRelease: !input.lifecycle || actions.has("unloaded"),
  wakeAgain: !input.lifecycle || wokeAgain,
  sourceRecovery: !input.lifecycle || newRunAfterStall,
  scopeRevocation:
    !input.lifecycle ||
    (actions.has("revoke") && actions.has("grant") && cancelledScope),
  asrRecovery:
    !input.lifecycle || (actions.has("freeze_asr") && recoveredModel),
  video: !input.video || (httpSnapshots > 0 && videoFrames > 0),
  cleanup: cleanup.processes === 1,
};
const report = {
  input,
  config,
  conditions,
  handoff: lastHandoff,
  deliveries,
  revocationHandoff,
  revokedHandoffRejections,
  passed: Object.values(conditions).every(Boolean),
  errors,
  parentPid: process.pid,
  actions: [...actions].map(([kind, action]) => ({ kind, ...action })),
  lastSnapshot,
  resources,
  observedProcesses: resourceSampler.observedProcesses(),
  cleanup,
  httpSnapshots,
  speechHttpSnapshots,
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
    "CPU accumulates the last observed values of owned processes; work between their final sample and exit is not counted",
  ],
};
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({ passed: report.passed, conditions, errors, output }),
);
if (!report.passed) process.exitCode = 1;
