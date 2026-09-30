import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createPerceptionService } from "../../src/perception/service";

async function until(check: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!check() && performance.now() < deadline) await delay(20);
  expect(check()).toBe(true);
}

test("exhausted compute recovery remains unavailable after reconciliation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p1-health-review-"));
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
    await service.start();
    for (let attempt = 0; attempt < 3; attempt++) {
      const pid = service.snapshot().compute!.processId!;
      process.kill(pid, "SIGKILL");
      await until(() =>
        attempt < 2
          ? service.snapshot().compute?.status === "ready" &&
            service.snapshot().compute?.processId !== pid
          : service.snapshot().compute?.status === "unavailable",
      );
    }
    await delay(600);
    expect(service.snapshot().compute?.status).toBe("unavailable");
    expect(service.snapshot().status).toBe("unavailable");
    expect(service.snapshot().error).toBeTruthy();
    await Promise.all([service.retry(), service.retry()]);
    await until(() => service.snapshot().status === "running");
    expect(service.snapshot().compute?.status).toBe("ready");
    expect(service.snapshot().error).toBeUndefined();
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
