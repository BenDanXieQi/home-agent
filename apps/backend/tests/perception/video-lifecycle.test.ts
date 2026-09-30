import { z } from "zod";
import { perceptionSnapshotSchema } from "@home-agent/api/contracts";
import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDetectionPool } from "../../src/perception/compute/pool";
import { createPerceptionService } from "../../src/perception/service";
import { createPerceptionRoutes } from "../../src/perception/routes";
import {
  perceptionConfigSchema,
  sourceSelectionSchema,
} from "../../src/perception/config";

async function until(check: () => boolean, timeout = 12000) {
  const end = performance.now() + timeout;
  while (!check() && performance.now() < end) await delay(20);
  expect(check()).toBe(true);
}
async function mediaServer(
  codec: "libx264" | "libx265" = "libx264",
  image?: string,
) {
  const directory = await mkdtemp(join(tmpdir(), "p1-video-"));
  const file = join(directory, "source.ts");
  await promisify(execFile)("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    ...(image
      ? ["-loop", "1", "-i", image]
      : ["-f", "lavfi", "-i", "testsrc2=size=96x64:rate=10"]),
    "-t",
    "2",
    "-an",
    "-c:v",
    codec,
    ...(codec === "libx265"
      ? ["-x265-params", "pools=none:frame-threads=1"]
      : []),
    "-threads",
    "1",
    "-preset",
    "ultrafast",
    "-g",
    "10",
    "-f",
    "mpegts",
    file,
  ]);
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
  const connections = new Map<string, Set<() => void>>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const { sourceId } = z
        .object({ sourceId: z.uuid() })
        .parse(await request.json());
      let timer: ReturnType<typeof setInterval>;
      let finish: () => void;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false;
          finish = () => {
            if (closed) return;
            closed = true;
            clearInterval(timer);
            controller.close();
            connections.get(sourceId)?.delete(finish);
          };
          const list = connections.get(sourceId) ?? new Set();
          list.add(finish);
          connections.set(sourceId, list);
          timer = setInterval(() => {
            if (controller.desiredSize! > 0) controller.enqueue(bytes);
          }, 200);
          request.signal.addEventListener("abort", finish, { once: true });
        },
        cancel() {
          clearInterval(timer);
          connections.get(sourceId)?.delete(finish);
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "video/mp2t" },
      });
    },
  });
  return {
    endpoint: `${server.url.toString()}analysis`,
    connections,
    drop(id: string) {
      for (const finish of connections.get(id) ?? []) finish();
    },
    async close() {
      for (const list of connections.values())
        for (const finish of list) finish();
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const selection = { deviceId: "123", channel: 1 as const };
const scopeEpoch = crypto.randomUUID();
const identity = "authorized";
function sources(endpoint: string) {
  return {
    list: () => [selection],
    eligibility: () => ({ scopeEpoch, revision: scopeEpoch, identity }),
    subscribe: () => () => {},
    async prepare(
      source: z.infer<typeof sourceSelectionSchema>,
      signal: AbortSignal,
    ) {
      return {
        access: {
          endpoint,
          sessionId: scopeEpoch,
          sourceId: source.channel === 1 ? firstSource : secondSource,
        },
        signal,
        scopeEpoch,
      };
    },
  };
}
const firstSource = crypto.randomUUID(),
  secondSource = crypto.randomUUID();

test("formal service isolates a lost channel, replaces its run, and closes all decoder processes", async () => {
  const media = await mediaServer();
  const directory = await mkdtemp(join(tmpdir(), "p1-config-"));
  const configPath = join(directory, "perception.json");
  await writeFile(
    configPath,
    JSON.stringify({
      sources: [selection, { ...selection, channel: 2 }],
      firstFrameTimeoutMs: 3000,
      silenceTimeoutMs: 1000,
    }),
  );
  const service = createPerceptionService({
    configPath,
    executable: "ffmpeg",
    sources: sources(media.endpoint),
  });
  let pids: number[] = [];
  try {
    await service.start();
    await until(
      () =>
        service.snapshot().sources.length === 2 &&
        service.snapshot().sources.every((s) => s.metrics.published >= 2),
    );
    const initial = service.snapshot();
    const before = initial.sources[0]!.run!.runId;
    const peer = initial.sources[1]!.run!.runId;
    const compute = initial.compute!.processId!;
    const { stdout } = await promisify(execFile)("pgrep", [
      "-P",
      String(compute),
    ]);
    pids = [compute, ...stdout.trim().split(/\s+/).map(Number)];
    expect(pids.length).toBe(3);
    media.drop(firstSource);
    await until(
      () => service.snapshot().sources[0]?.validity === "unavailable",
    );
    await until(
      () =>
        service.snapshot().sources[0]?.run?.runId !== before &&
        service.snapshot().sources[0]?.validity === "valid",
    );
    expect(service.snapshot().sources[1]?.run?.runId).toBe(peer);
    expect(service.snapshot().sources[1]?.metrics.published).toBeGreaterThan(
      initial.sources[1]!.metrics.published,
    );
  } finally {
    await service.close();
    await media.close();
    await rm(directory, { recursive: true, force: true });
  }
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
}, 20000);

test("video hard deadline kills the decoder process group before compute recovery", async () => {
  const media = await mediaServer("libx265");
  const pool = await createDetectionPool({
    taskTimeoutMs: 300,
    closeTimeoutMs: 3000,
    recoveryDelayMs: 10,
    maxRestarts: 1,
  });
  const oldPid = pool.getStatus().processId!;
  let childPids: number[] = [];
  let freeze = false,
    submitted = false;
  const unsubscribe = pool.subscribeVideo((event) => {
    if (event.event === "submitted" && freeze && !submitted) {
      submitted = true;
      process.kill(oldPid, "SIGSTOP");
    }
  });
  try {
    await pool.startVideo({
      run: { ...selection, scopeEpoch, runId: crypto.randomUUID() },
      access: {
        endpoint: media.endpoint,
        sessionId: scopeEpoch,
        sourceId: firstSource,
      },
      config: perceptionConfigSchema.parse({ sources: [selection] }),
      executable: "ffmpeg",
    });
    await until(() => Boolean(media.connections.get(firstSource)?.size));
    await delay(500);
    const { stdout } = await promisify(execFile)("pgrep", [
      "-P",
      String(oldPid),
    ]);
    childPids = stdout.trim().split(/\s+/).map(Number);
    expect(childPids.length).toBe(1);
    freeze = true;
    await until(() => submitted);
    await until(
      () =>
        pool.getStatus().status === "ready" &&
        pool.getStatus().processId !== oldPid,
    );
    for (const pid of [oldPid, ...childPids])
      expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    unsubscribe();
    await pool.close();
    await media.close();
  }
}, 15000);

test("invalid configuration and missing FFmpeg keep health and retry accessible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p1-unavailable-"));
  const configPath = join(directory, "perception.json");
  try {
    for (const content of ["{", JSON.stringify({ sources: [selection] })]) {
      await writeFile(configPath, content);
      const service = createPerceptionService({
        configPath,
        executable: "/missing/p1-ffmpeg",
        sources: sources("http://127.0.0.1:1/analysis"),
      });
      const shutdown = new AbortController();
      try {
        await service.start();
        const app = createPerceptionRoutes(service, 3000, shutdown.signal);
        const env = {
          requestIP: () => ({
            address: "127.0.0.1",
            family: "IPv4",
            port: 12345,
          }),
        };
        const health = await app.request(
          "http://localhost:3000/",
          { headers: { Host: "localhost:3000" } },
          env,
        );
        expect(health.status).toBe(200);
        expect(perceptionSnapshotSchema.parse(await health.json()).status).toBe(
          "unavailable",
        );
        const retry = await app.request(
          "http://localhost:3000/retry",
          {
            method: "POST",
            headers: {
              Origin: "http://localhost:3000",
              Host: "localhost:3000",
            },
          },
          env,
        );
        expect(retry.status).toBe(200);
        expect(perceptionSnapshotSchema.parse(await retry.json()).status).toBe(
          "unavailable",
        );
      } finally {
        shutdown.abort();
        await service.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repeated video starts and stops release each decoder without replacing compute", async () => {
  const media = await mediaServer();
  const pool = await createDetectionPool();
  const pid = pool.getStatus().processId!;
  const completed = new Set<string>();
  const unsubscribe = pool.subscribeVideo((event) => {
    if (event.event === "settled") completed.add(event.run.runId);
  });
  try {
    for (let cycle = 0; cycle < 20; cycle++) {
      const runId = crypto.randomUUID();
      await pool.startVideo({
        run: { ...selection, scopeEpoch, runId },
        access: {
          endpoint: media.endpoint,
          sessionId: scopeEpoch,
          sourceId: firstSource,
        },
        config: perceptionConfigSchema.parse({}),
        executable: "ffmpeg",
      });
      await until(() => completed.has(runId));
      const { stdout } = await promisify(execFile)("pgrep", [
        "-P",
        String(pid),
      ]);
      const decoders = stdout.trim().split(/\s+/).map(Number);
      await pool.stopVideo(runId);
      for (const decoder of decoders)
        expect(() => process.kill(decoder, 0)).toThrow();
      await until(() => media.connections.get(firstSource)?.size === 0);
      expect(pool.getStatus()).toMatchObject({
        status: "ready",
        restarts: 0,
        processId: pid,
      });
    }
  } finally {
    unsubscribe();
    await pool.close();
    await media.close();
  }
}, 15000);

test("SSE connection capacity is bounded and HEAD consumes no subscription", async () => {
  const service = createPerceptionService({
    configPath: join(tmpdir(), `missing-p1-${crypto.randomUUID()}.json`),
    executable: "ffmpeg",
    sources: sources("http://127.0.0.1:1/analysis"),
  });
  const shutdown = new AbortController();
  const responses: Response[] = [];
  const env = {
    requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 12345 }),
  };
  const app = createPerceptionRoutes(service, 3000, shutdown.signal);
  try {
    await service.start();
    for (let index = 0; index < 16; index++) {
      const response = await app.request(
        "http://localhost:3000/stream",
        { headers: { Host: "localhost:3000" } },
        env,
      );
      expect(response.status).toBe(200);
      responses.push(response);
    }
    const head = await app.request(
      "http://localhost:3000/stream",
      { method: "HEAD", headers: { Host: "localhost:3000" } },
      env,
    );
    expect(head.status).toBe(200);
    const excess = await app.request(
      "http://localhost:3000/stream",
      { headers: { Host: "localhost:3000" } },
      env,
    );
    expect(excess.status).toBe(503);
    const health = await app.request(
      "http://localhost:3000/",
      { headers: { Host: "localhost:3000" } },
      env,
    );
    expect(health.status).toBe(200);
  } finally {
    shutdown.abort();
    await Promise.all(responses.map((response) => response.body?.cancel()));
    await service.close();
  }
});

test("household channel changes alter only sources while the startup pool stays fixed", async () => {
  const media = await mediaServer();
  const directory = await mkdtemp(join(tmpdir(), "perception-household-"));
  const configPath = join(directory, "perception.json");
  await writeFile(
    configPath,
    JSON.stringify({ sources: "household", cpuRatio: 0.5 }),
  );
  let selected: Array<z.infer<typeof sourceSelectionSchema>> = [selection];
  const listeners = new Set<() => void>();
  const adapter = sources(media.endpoint);
  const service = createPerceptionService({
    configPath,
    executable: "ffmpeg",
    sources: {
      ...adapter,
      list: () => selected,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  });
  const change = (next: typeof selected) => {
    selected = next;
    for (const listener of listeners) listener();
  };
  try {
    await service.start();
    await until(() => service.snapshot().sources[0]?.validity === "valid");
    const before = service.snapshot();
    const pid = before.compute!.processId;
    const budget = before.compute!.budget;
    change([selection, { ...selection, channel: 2 }]);
    await until(
      () =>
        service.snapshot().sources.length === 2 &&
        service
          .snapshot()
          .sources.every((source) => source.validity === "valid"),
    );
    change([{ ...selection, channel: 2 }]);
    expect(
      service.snapshot().sources.map((source) => source.source.channel),
    ).toEqual([2]);
    expect(service.snapshot().compute).toMatchObject({
      processId: pid,
      budget,
      restarts: 0,
    });
    expect(service.snapshot().model!.workerThreadIds.length).toBe(
      budget.workersPerProcess,
    );
  } finally {
    await service.close();
    await media.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);

test("video dispatch uses multiple slots but retains each source until its result is sent", async () => {
  const { createVideoRuntime } =
    await import("../../src/perception/video/runtime");
  const { readAnalysisStream } =
    await import("../../src/mijia/media/analysis-stream");
  const media = await mediaServer();
  const sent = Promise.withResolvers<void>();
  let active = 0,
    peak = 0,
    submitted = 0,
    settled = 0;
  const listeners = new Set<() => void>();
  const runtime = createVideoRuntime({
    tracking: {
      start() {},
      stop() {},
      capture() {
        return undefined;
      },
      async close() {},
    },
    compute: {
      get available() {
        return active < 2;
      },
      subscribeAvailable(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async detect(_frame, onAdmitted) {
        active++;
        peak = Math.max(peak, active);
        try {
          await onAdmitted?.();
          await delay(100);
          return {
            kind: "detected" as const,
            detections: [],
            timing: {
              readMs: 0,
              decodeMs: 0,
              preprocessMs: 0,
              inferenceMs: 100,
              postprocessMs: 0,
              queueMs: 0,
              workerDispatchMs: 0,
            },
          };
        } finally {
          active--;
          for (const listener of listeners) listener();
        }
      },
    },
    emit: async (event) => {
      if (event.event === "submitted") submitted++;
      if (event.event === "settled") {
        settled++;
        await sent.promise;
      }
    },
    fatal: (error) => {
      throw error;
    },
  });
  try {
    for (const channel of [1, 2] as const)
      runtime.start({
        run: { ...selection, channel, scopeEpoch, runId: crypto.randomUUID() },
        decoder: {
          executable: "ffmpeg",
          read: (signal) =>
            readAnalysisStream(
              {
                endpoint: media.endpoint,
                sessionId: scopeEpoch,
                sourceId: channel === 1 ? firstSource : secondSource,
              },
              signal,
            ),
        },
        config: perceptionConfigSchema.parse({ sampleFps: 30 }),
      });
    await until(() => settled === 2);
    await delay(500);
    expect(peak).toBe(2);
    expect(submitted).toBe(2);
    sent.resolve();
    await until(() => submitted > 2);
  } finally {
    sent.resolve();
    await runtime.close();
    await media.close();
  }
}, 10000);

test.skipIf(!process.env.PERCEPTION_INDOOR_DATA_DIR)(
  "P2 real detection and ReID publish independently on two video channels and survive appearance process failure",
  async () => {
    const media = await mediaServer(
      "libx264",
      join(process.env.PERCEPTION_INDOOR_DATA_DIR!, "images", "000000465549.jpg"),
    );
    const directory = await mkdtemp(join(tmpdir(), "p2-video-"));
    const configPath = join(directory, "perception.json");
    await writeFile(
      configPath,
      JSON.stringify({
        sources: [selection, { ...selection, channel: 2 }],
        sampleFps: 3,
      }),
    );
    const service = createPerceptionService({
      configPath,
      executable: "ffmpeg",
      sources: sources(media.endpoint),
    });
    let children: number[] = [];
    try {
      await service.start();
      await until(
        () =>
          service.snapshot().sources.length === 2 &&
          service
            .snapshot()
            .sources.every((s) =>
              s.tracking?.tracks.some(
                (t) => t.feature === "extracted" || t.feature === "reused",
              ),
            ),
        15000,
      );
      const view = service.snapshot();
      expect(view.compute!.budget.workersPerProcess).toBeGreaterThan(1);
      for (const source of view.sources) {
        expect(source.metrics.published).toBeGreaterThanOrEqual(2);
        expect(
          source.tracking!.tracks.filter((t) => t.state === "measured").length,
        ).toBeGreaterThanOrEqual(2);
        expect(source.tracking!.sequence).toBeLessThanOrEqual(
          source.observation!.sequence,
        );
      }
      const routes = createPerceptionRoutes(
        service,
        1810,
        new AbortController().signal,
      );
      const response = await routes.request(
        "http://localhost:1810/",
        { headers: { Host: "localhost:1810" } },
        {
          requestIP: () => ({
            address: "127.0.0.1",
            family: "IPv4",
            port: 12345,
          }),
        },
      );
      const publicView = perceptionSnapshotSchema.parse(await response.json());
      expect(publicView.sources.every((s) => s.tracking?.tracks.length)).toBe(
        true,
      );
      const pid = view.compute!.processId!;
      const { stdout } = await promisify(execFile)("pgrep", [
        "-P",
        String(pid),
      ]);
      children = stdout.trim().split(/\s+/).map(Number);
      let appearance: number | undefined;
      for (const child of children) {
        const { stdout: command } = await promisify(execFile)("ps", [
          "-p",
          String(child),
          "-o",
          "command=",
        ]);
        if (command.includes("reid-entry")) appearance = child;
      }
      expect(appearance).toBeDefined();
      process.kill(appearance!, "SIGKILL");
      await until(() =>
        service
          .snapshot()
          .sources.every(
            (s) =>
              s.metrics.published >
                view.sources.find(
                  (old) => old.source.channel === s.source.channel,
                )!.metrics.published +
                  3 && s.tracking?.status === "degraded",
          ),
      );
      expect(service.snapshot().compute?.processId).toBe(pid);
      expect(service.snapshot().compute?.restarts).toBe(0);
    } finally {
      await service.close();
      await media.close();
      await rm(directory, { recursive: true, force: true });
    }
    for (const pid of children) expect(() => process.kill(pid, 0)).toThrow();
  },
  25000,
);
