import { inferenceRequest } from "../../src/perception/compute/inference-protocol";
import { expect, test, spyOn } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import * as childProcess from "node:child_process";
import { petSoundObservationSchema } from "@home-agent/api/contracts";
import { createPetSoundRuntime } from "../../src/perception/pet-sound/runtime";
import { petSoundJobSchema } from "../../src/perception/pet-sound/protocol";
import { petSoundModelSha256 } from "../../src/perception/pet-sound/model";
import { planPerceptionResources } from "../../src/perception/compute/resources";
import { perceptionConfigSchema } from "../../src/perception/config";

async function until(check: () => boolean) {
  const deadline = performance.now() + 1000;
  while (!check() && performance.now() < deadline) await delay(1);
  expect(check()).toBe(true);
}

// Only replace the OS/native-worker boundary. Real segmentation, ownership,
// queueing, protocol validation and publication remain in the production runtime.
function nativeChild() {
  const process = new childProcess.ChildProcess();
  Object.defineProperty(process, "stderr", { value: null });
  const jobs: ReturnType<typeof petSoundJobSchema.parse>[] = [];
  const requests: string[] = [];
  Object.defineProperty(process, "send", {
    configurable: true,
    writable: true,
    value: (message: unknown) => {
      const request = inferenceRequest(petSoundJobSchema).parse(message);
      requests.push(request.requestId);
      jobs.push(request.input);
      return true;
    },
  });
  const send = spyOn(process, "send");
  const kill = spyOn(process, "kill").mockImplementation(() => {
    queueMicrotask(() => {
      process.emit("exit", null, "SIGKILL");
    });
    return true;
  });
  return {
    process,
    jobs,
    kill,
    send,
    ready() {
      process.emit("message", {
        requestId: null,
        message: {
          kind: "ready",
          modelSha256: petSoundModelSha256,
          rssBytes: 1024,
        },
      });
    },
    complete() {
      process.emit("message", {
        requestId: requests.at(-1),
        message: {
          kind: "result",
          id: jobs.at(-1)!.id,
          events: [{ label: "Bark", score: 0.9 }],
          elapsedMs: 20,
          rssBytes: 1024,
        },
      });
    },
  };
}
function workers() {
  const children: ReturnType<typeof nativeChild>[] = [];
  const fork = spyOn(childProcess, "fork").mockImplementation(() => {
    const instance = nativeChild();
    children.push(instance);
    return instance.process;
  });
  return {
    children,
    restore() {
      fork.mockRestore();
      for (const child of children) {
        child.send.mockRestore();
        child.kill.mockRestore();
      }
    },
  };
}

function source() {
  return {
    deviceId: "123",
    scopeEpoch: crypto.randomUUID(),
    trackRunId: crypto.randomUUID(),
  };
}

test("slow pet inference cannot hold PCM, pending contexts stay bounded, and revoked native work cannot publish", async () => {
  const native = workers();
  const observations: ReturnType<typeof petSoundObservationSchema.parse>[] = [];
  const updates = new Map<
    string,
    Parameters<Parameters<typeof createPetSoundRuntime>[0]["update"]>[1]
  >();
  const errors: unknown[] = [];
  const runtime = createPetSoundRuntime({
    threshold: 0.4,
    update(runId, value) {
      updates.set(runId, value);
    },
    async deliver(value) {
      observations.push(value);
    },
    fatal(error) {
      errors.push(error);
    },
  });
  const first = source(),
    second = { ...source(), deviceId: "456" };
  try {
    runtime.start(first);
    runtime.start(second);
    runtime.media(first.trackRunId, crypto.randomUUID());
    runtime.media(second.trackRunId, crypto.randomUUID());
    runtime.accept(
      first.trackRunId,
      new Int16Array(64000).fill(16384),
      0,
      8000,
    );
    native.children[0]!.ready();
    await until(() => native.children[0]!.jobs.length === 1);
    runtime.accept(second.trackRunId, new Int16Array(64000), 0, 8000);
    runtime.accept(first.trackRunId, new Int16Array(32000), 64000, 12000);
    runtime.accept(first.trackRunId, new Int16Array(32000), 96000, 14000);
    expect(updates.get(first.trackRunId)?.dropped).toBe(1);
    expect(observations).toEqual([]);
    expect(
      native.children[0]!.jobs[0]!.samples.every((sample) => sample === 0.5),
    ).toBe(true);
    runtime.end(first.trackRunId);
    expect(native.children[0]!.kill).toHaveBeenCalled();
    native.children[0]!.complete();
    await until(() => native.children.length === 2);
    native.children[1]!.ready();
    await until(() => native.children[1]!.jobs.length === 1);
    native.children[1]!.complete();
    await until(() => observations.length === 1);
    expect(petSoundObservationSchema.parse(observations[0]).run).toEqual(
      second,
    );
    expect(updates.get(second.trackRunId)?.status).toBe("ready");
    expect(errors).toEqual([]);
    runtime.end(second.trackRunId);
    await until(() => native.children[1]!.kill.mock.calls.length > 0);
    const replacement = source();
    runtime.start(replacement);
    runtime.media(replacement.trackRunId, crypto.randomUUID());
    runtime.accept(replacement.trackRunId, new Int16Array(64000), 0, 20000);
    await until(() => native.children.length === 3);
    native.children[2]!.ready();
    await until(() => native.children[2]!.jobs.length === 1);
    native.children[2]!.complete();
    await until(() => observations.length === 2);
    expect(observations[1]!.run).toEqual(replacement);
    expect(errors).toEqual([]);
  } finally {
    await runtime.close();
    native.restore();
  }
});

test("discontinuous media cannot publish an in-flight pet observation", async () => {
  const native = workers();
  const observations: unknown[] = [];
  const updates: Parameters<
    Parameters<typeof createPetSoundRuntime>[0]["update"]
  >[1][] = [];
  const errors: unknown[] = [];
  const runtime = createPetSoundRuntime({
    threshold: 0.4,
    update(_runId, value) {
      updates.push(value);
    },
    async deliver(value) {
      observations.push(value);
    },
    fatal(error) {
      errors.push(error);
    },
  });
  const run = source();
  try {
    runtime.start(run);
    runtime.media(run.trackRunId, crypto.randomUUID());
    runtime.accept(run.trackRunId, new Int16Array(64000), 0, 8000);
    native.children[0]!.ready();
    await until(() => native.children[0]!.jobs.length === 1);
    runtime.media(run.trackRunId, crypto.randomUUID());
    native.children[0]!.complete();
    await delay(10);
    expect(observations).toEqual([]);
    expect(updates.at(-1)?.status).toBe("unavailable");
    expect(updates.at(-1)?.error).toContain("generation changed");
    expect(errors).toEqual([]);
  } finally {
    await runtime.close();
    native.restore();
  }
});

test("optional pet inference reserves its own CPU slot and cannot silently exceed the minimum budget", () => {
  const config = perceptionConfigSchema.parse({
    sources: [{ deviceId: "123", channel: 1 }],
    cpuRatio: 0.0001,
    petSounds: { enabled: true },
  });
  expect(() => planPerceptionResources(config)).toThrow("resource budget");
  expect(
    planPerceptionResources({
      ...config,
      petSounds: { ...config.petSounds, enabled: false },
    }).petSoundThreads,
  ).toBe(0);
});

test("pet model failure and retry preserve the audio run and resume its continuous sample clock", async () => {
  const native = workers();
  const observations: ReturnType<typeof petSoundObservationSchema.parse>[] = [];
  const updates: Parameters<
    Parameters<typeof createPetSoundRuntime>[0]["update"]
  >[1][] = [];
  const errors: unknown[] = [];
  const runtime = createPetSoundRuntime({
    threshold: 0.4,
    update(_runId, value) {
      updates.push(value);
    },
    async deliver(value) {
      observations.push(value);
    },
    fatal(error) {
      errors.push(error);
    },
  });
  const run = source(),
    generation = crypto.randomUUID();
  try {
    runtime.start(run);
    runtime.media(run.trackRunId, generation);
    runtime.accept(run.trackRunId, new Int16Array(64000), 0, 8000);
    native.children[0]!.ready();
    await until(() => native.children[0]!.jobs.length === 1);
    native.children[0]!.process.emit("message", {
      requestId: null,
      message: {
        kind: "fatal",
        error: "Native model unavailable",
      },
    });
    await until(() => updates.at(-1)?.status === "unavailable");
    expect(updates.at(-1)?.validity).toBe("no_data");
    expect(updates.at(-1)?.dropped).toBe(1);
    runtime.accept(run.trackRunId, new Int16Array(32000), 64000, 12000);
    runtime.retry();
    await until(() => native.children.length === 2);
    native.children[1]!.ready();
    await until(() => native.children[1]!.jobs.length === 1);
    native.children[1]!.complete();
    await until(() => observations.length === 1);
    expect(observations[0]!.run).toEqual(run);
    expect(observations[0]!.generation).toBe(generation);
    expect(observations[0]!.startSample).toBe(32000);
    expect(observations[0]!.endSample).toBe(96000);
    expect(updates.at(-1)?.status).toBe("ready");
    expect(updates.at(-1)?.error).toBeUndefined();
    expect(errors).toEqual([]);
  } finally {
    await runtime.close();
    native.restore();
  }
});
