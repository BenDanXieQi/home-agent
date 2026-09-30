import { afterAll, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const original = { ...(await import("../../src/perception/compute/process")) };
const processes: Array<ReturnType<typeof original.createDetectionProcess>> = [];
const cleanupEntered = Promise.withResolvers<void>();
const allowConfirmation = Promise.withResolvers<void>();
const retryEntered = Promise.withResolvers<void>();
const allowRetry = Promise.withResolvers<void>();
await mock.module("../../src/perception/compute/process", () => ({
  ...original,
  createDetectionProcess(
    ...args: Parameters<typeof original.createDetectionProcess>
  ) {
    const child = original.createDetectionProcess(...args);
    processes.push(child);
    const first = processes.length === 1;
    return {
      ...child,
      async destroy() {
        await child.destroy();
        if (first) {
          cleanupEntered.resolve();
          await allowConfirmation.promise;
        }
      },
      async submit(task: Parameters<typeof child.submit>[0]) {
        if (task.kind === "initialize") {
          // Fail at the model boundary with a real OS process still owned by the pool.
          if (first) throw new Error("Model initialization failed");
          retryEntered.resolve();
          await allowRetry.promise;
        }
        return child.submit(task);
      },
    };
  },
}));
afterAll(async () => {
  await mock.module("../../src/perception/compute/process", () => original);
});
const { createPerceptionService } =
  await import("../../src/perception/service");
test("failed model initialization releases resources and concurrent explicit retry initializes once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p1-init-"));
  const configPath = join(directory, "perception.json");
  await writeFile(
    configPath,
    JSON.stringify({
      cpuRatio: 0.01,
      sources: [{ deviceId: "123", channel: 1 }],
    }),
  );
  const service = createPerceptionService({
    configPath,
    executable: "ffmpeg",
    sources: {
      list: () => [],
      eligibility: () => null,
      subscribe: () => () => {},
      prepare: async () => {
        throw new Error("No access granted");
      },
    },
  });
  try {
    let startFinished = false;
    const starting = service.start().then(() => {
      startFinished = true;
    });
    await cleanupEntered.promise;
    expect(startFinished).toBe(false);
    allowConfirmation.resolve();
    await starting;
    expect(service.snapshot().status).toBe("unavailable");
    expect(service.snapshot().compute).toBeNull();
    expect(service.snapshot().error).toContain("Model initialization failed");
    const failedPid = processes[0]!.pid!;
    expect(failedPid).toBeGreaterThan(0);
    expect(() => process.kill(failedPid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
    expect(() => process.kill(-failedPid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
    const retries = [service.retry(), service.retry(), service.retry()];
    await retryEntered.promise;
    expect(processes).toHaveLength(2);
    allowRetry.resolve();
    await Promise.all(retries);
    expect(processes).toHaveLength(2);
    expect(service.snapshot().compute?.status).toBe("ready");
  } finally {
    allowConfirmation.resolve();
    allowRetry.resolve();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
  for (const child of processes)
    expect(() => process.kill(child.pid!, 0)).toThrow();
}, 10000);
