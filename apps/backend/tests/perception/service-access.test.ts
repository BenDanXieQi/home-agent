import type { z } from "zod";
import type { videoStartSchema } from "../../src/perception/compute/protocol";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createVideoMetrics } from "../../src/perception/video/metrics";
import type { createPerceptionService as Service } from "../../src/perception/service";

type Sources = Parameters<typeof Service>[0]["sources"];
type PreparedSource = Awaited<ReturnType<Sources["prepare"]>>;

const original = { ...(await import("../../src/perception/compute/process")) };
const children: Array<ReturnType<typeof original.createDetectionProcess>> = [];
const starts: Array<z.infer<typeof videoStartSchema>> = [];
const stops: string[] = [];
await mock.module("../../src/perception/compute/process", () => ({
  ...original,
  createDetectionProcess(
    ...args: Parameters<typeof original.createDetectionProcess>
  ) {
    const child = original.createDetectionProcess(...args);
    children.push(child);
    return {
      ...child,
      async submit(task: Parameters<typeof child.submit>[0]) {
        // Control media completions at IPC; service, pool and observation store stay real.
        if (task.kind === "video_start") {
          starts.push(task.source);
          return { kind: "video_ack" as const };
        }
        if (task.kind === "video_stop") {
          stops.push(task.runId);
          return { kind: "video_ack" as const };
        }
        return child.submit(task);
      },
    };
  },
}));
afterAll(async () => {
  await mock.module("../../src/perception/compute/process", () => original);
});
beforeEach(() => {
  children.length = 0;
  starts.length = 0;
  stops.length = 0;
});
const { createPerceptionService } =
  await import("../../src/perception/service");

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "p1-access-"));
  const configPath = join(directory, "perception.json");
  const selection = { deviceId: "123", channel: 1 as const };
  await writeFile(
    configPath,
    JSON.stringify({ cpuRatio: 0.01, sources: [selection] }),
  );
  const listeners = new Set<() => void>();
  let access: ReturnType<Sources["eligibility"]> = {
    scopeEpoch: crypto.randomUUID(),
    revision: crypto.randomUUID(),
    identity: "first",
  };
  const preparations: Array<{
    signal: AbortSignal;
    scopeEpoch: PreparedSource["scopeEpoch"];
    result: ReturnType<typeof Promise.withResolvers<PreparedSource>>;
  }> = [];
  const service = createPerceptionService({
    configPath,
    executable: "ffmpeg",
    sources: {
      list: () => [selection],
      eligibility: () => access,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      prepare(_source, signal) {
        const result = Promise.withResolvers<PreparedSource>();
        preparations.push({ signal, scopeEpoch: access!.scopeEpoch, result });
        return result.promise;
      },
    },
  });
  function notify() {
    for (const listener of listeners) listener();
  }
  return {
    service,
    preparations,
    notify,
    revoke() {
      access = null;
      notify();
    },
    rebind() {
      access = {
        scopeEpoch: crypto.randomUUID(),
        revision: crypto.randomUUID(),
        identity: "second",
      };
      notify();
    },
    finish(index: number) {
      const prepared = preparations[index]!;
      prepared.result.resolve({
        access: {
          endpoint: "http://127.0.0.1:1/analysis",
          sessionId: crypto.randomUUID(),
          sourceId: crypto.randomUUID(),
        },
        // An uncooperative supplier may complete even after its request was cancelled.
        signal: new AbortController().signal,
        scopeEpoch: prepared.scopeEpoch,
      });
    },
    publish(run: (typeof starts)[number]["run"], sequence: number) {
      children[0]!.events.emit("video", {
        event: "settled",
        run,
        sequence,
        metrics: createVideoMetrics().snapshot(),
        observation: {
          run,
          sequence,
          receivedAt: Date.now(),
          sampledAt: Date.now(),
          mediaTime: null,
          width: 1,
          height: 1,
          coordinateBasis: "decoded_rgb24",
          detections: [],
          ageMs: 0,
        },
      });
    },
    async close() {
      for (const prepared of preparations)
        prepared.result.reject(new Error("Test ending"));
      try {
        await service.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

test("revocation during media preparation cancels the old request and its late completion cannot start video", async () => {
  const h = await harness();
  try {
    await h.service.start();
    expect(h.preparations).toHaveLength(1);
    h.revoke();
    expect(h.preparations[0]!.signal.aborted).toBe(true);
    expect(h.service.snapshot().sources[0]?.validity).toBe("unavailable");
    h.rebind();
    h.finish(0);
    await nextTurn();
    expect(starts).toHaveLength(0);
    // Notify after retirement drains; avoid waiting for the periodic reconciliation timer.
    h.notify();
    expect(h.preparations).toHaveLength(2);
    h.finish(1);
    await nextTurn();
    expect(starts).toHaveLength(1);
    expect(starts[0]!.run.scopeEpoch).toBe(h.preparations[1]!.scopeEpoch);
    h.publish(starts[0]!.run, 1);
    expect(h.service.snapshot().sources[0]?.validity).toBe("valid");
  } finally {
    await h.close();
  }
}, 10000);

test("revocation clears published evidence and late results cannot contaminate a rebound household", async () => {
  const h = await harness();
  try {
    await h.service.start();
    h.finish(0);
    await nextTurn();
    expect(starts).toHaveLength(1);
    const old = starts[0]!.run;
    h.publish(old, 1);
    expect(h.service.snapshot().sources[0]?.validity).toBe("valid");
    h.revoke();
    h.publish(old, 2);
    expect(h.service.snapshot().sources[0]).toMatchObject({
      validity: "unavailable",
      observation: null,
    });
    await nextTurn();
    expect(stops).toContain(old.runId);
    h.rebind();
    h.finish(1);
    await nextTurn();
    expect(starts).toHaveLength(2);
    const current = starts[1]!.run;
    expect(current.scopeEpoch).not.toBe(old.scopeEpoch);
    h.publish(current, 1);
    h.publish(old, 999);
    children[0]!.events.emit("video", {
      event: "health",
      run: old,
      status: "failed",
      error: "Retired source failed",
      metrics: createVideoMetrics().snapshot(),
    });
    await nextTurn();
    expect(h.service.snapshot().sources[0]).toMatchObject({
      run: current,
      validity: "valid",
      observation: { run: current, sequence: 1 },
    });
    expect(h.preparations[1]!.signal.aborted).toBe(false);
    expect(stops).not.toContain(current.runId);
  } finally {
    await h.close();
  }
}, 10000);
