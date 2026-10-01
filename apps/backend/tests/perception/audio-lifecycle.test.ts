import { test, expect } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { createAudioSource } from "../../scripts/perception-evaluation/audio-source";
import { createAudioService } from "../../src/perception/audio/service";
import { perceptionConfigSchema } from "../../src/perception/config";

async function until(check: () => boolean, milliseconds = 10_000) {
  const deadline = performance.now() + milliseconds;
  while (!check() && performance.now() < deadline) await delay(25);
  expect(check()).toBe(true);
}
async function start(count = 1) {
  const source = await createAudioSource(count);
  const config = perceptionConfigSchema.parse({
    sources: source.selected,
    silenceTimeoutMs: 1500,
    maxFrameAgeMs: 1000,
  });
  const service = createAudioService({
    sources: source.sources,
    executable: process.env.PERCEPTION_FFMPEG_PATH ?? "ffmpeg",
    changed() {},
  });
  service.start();
  const reconcile = () => {
    service.reconcile(config, source.selected);
  };
  const timer = setInterval(reconcile, 100);
  reconcile();
  return {
    source,
    service,
    reconcile,
    async close() {
      clearInterval(timer);
      await service.close();
      await source.close();
    },
  };
}

test("revoked household access removes facts immediately and a replacement cannot inherit them", async () => {
  const run = await start();
  try {
    await until(() => (run.service.snapshot().tracks[0]?.samples ?? 0) > 8000);
    const old = run.service.snapshot().tracks[0]!;
    run.source.revoke();
    expect(run.service.snapshot().tracks).toEqual([]);
    await delay(150);
    expect(run.service.snapshot().tracks).toEqual([]);
    run.source.modes.set(run.source.selected[0]!.deviceId, "quiet");
    run.source.grant();
    run.reconcile();
    await until(
      () => (run.service.snapshot().tracks[0]?.energy.length ?? 0) > 0,
    );
    const current = run.service.snapshot().tracks[0]!;
    expect(current.run.trackRunId).not.toBe(old.run.trackRunId);
    expect(current.run.scopeEpoch).not.toBe(old.run.scopeEpoch);
    expect(current.samples).toBeLessThan(old.samples);
    expect(current.energy.every((block) => !block.active)).toBe(true);
  } finally {
    await run.close();
  }
  expect(run.source.activeReaders).toBe(0);
}, 20000);

test("a stalled camera becomes unknown while the other camera continues, then recovers as a new run", async () => {
  const run = await start(2);
  try {
    await until(
      () =>
        run.service.snapshot().tracks.length === 2 &&
        run.service.snapshot().tracks.every((track) => track.samples > 8000),
    );
    const before = run.service.snapshot().tracks;
    run.source.modes.set(run.source.selected[0]!.deviceId, "stalled");
    await until(() => run.service.snapshot().tracks[0]?.status === "failed");
    const failed = run.service.snapshot().tracks[0]!;
    expect(failed.validity).toBe("unavailable");
    expect(failed.vad).toEqual([]);
    const healthy = run.service.snapshot().tracks[1]!;
    expect(healthy.run.trackRunId).toBe(before[1]!.run.trackRunId);
    expect(healthy.samples).toBeGreaterThan(before[1]!.samples);
    run.source.modes.set(run.source.selected[0]!.deviceId, "tone");
    await until(
      () =>
        run.service
          .snapshot()
          .tracks.some(
            (track) =>
              track.run.deviceId === before[0]!.run.deviceId &&
              track.run.trackRunId !== before[0]!.run.trackRunId &&
              track.samples > 0,
          ),
      12000,
    );
  } finally {
    await run.close();
  }
}, 30000);

test("an old buffered stream cannot refresh the current sound facts", async () => {
  const run = await start();
  try {
    run.source.modes.set(run.source.selected[0]!.deviceId, "old");
    await until(() => run.service.snapshot().tracks[0]?.status === "failed");
    const view = run.service.snapshot().tracks[0]!;
    expect(view.validity).toBe("unavailable");
    expect(view.samples).toBe(0);
    expect(view.energy).toEqual([]);
    expect(view.vad).toEqual([]);
  } finally {
    await run.close();
  }
}, 15000);

test("closing during startup releases the process and source ownership", async () => {
  const run = await start();
  const pid = run.service.snapshot().processId;
  await run.close();
  expect(run.service.snapshot().status).toBe("closed");
  expect(run.source.activeReaders).toBe(0);
  if (pid) expect(() => process.kill(pid, 0)).toThrow();
}, 10000);

test("a camera without an audio track is unknown, not quiet, while another camera keeps reporting sound", async () => {
  const run = await start(2);
  try {
    run.source.modes.set(run.source.selected[0]!.deviceId, "missing");
    await until(
      () =>
        run.service.snapshot().tracks[0]?.status === "no_track" &&
        (run.service.snapshot().tracks[1]?.samples ?? 0) > 4000,
    );
    const [missing, present] = run.service.snapshot().tracks;
    expect(missing!.validity).toBe("unavailable");
    expect(missing!.energy).toEqual([]);
    expect(missing!.vadStatus).toBe("unavailable");
    expect(present!.validity).toBe("valid");
  } finally {
    await run.close();
  }
}, 15000);
