import { expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { createFfmpegDecoder } from "../../src/perception/media/ffmpeg-decoder";

for (const inputFps of [20, 2]) {
  test(`decoder samples ${inputFps} fps input before RGB without duplicating frames`, async () => {
    const producer = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-progress",
        "pipe:2",
        "-stats_period",
        "0.1",
        "-re",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=320x240:rate=${inputFps}`,
        "-an",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-g",
        "1",
        "-f",
        "mpegts",
        "pipe:1",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const progress = new Response(producer.stderr).text();
    let frames = 0;
    const pixels = new Set<ReturnType<typeof Bun.hash>>();
    const first = Promise.withResolvers<void>();
    const decoder = createFfmpegDecoder({
      executable: "ffmpeg",
      sampleFps: 3,
      firstFrameTimeoutMs: 5000,
      silenceTimeoutMs: 3000,
      read: async (signal) => {
        signal.addEventListener("abort", () => producer.kill(), { once: true });
        return producer.stdout;
      },
      onFrame(frame) {
        expect(frame.rgb.byteLength).toBe(320 * 240 * 3);
        frames++;
        pixels.add(Bun.hash(frame.rgb));
        first.resolve();
      },
    });
    // Observe decoder failure while waiting, including first-frame timeout.
    const outcome = decoder.completed.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      await Promise.race([
        first.promise,
        outcome.then((result) => {
          if (!result.ok) throw result.error;
        }),
      ]);
      await delay(2200);
      expect(frames).toBeGreaterThanOrEqual(4);
    } finally {
      await decoder.close();
      producer.kill();
      await producer.exited;
    }
    const produced = [...(await progress).matchAll(/^frame=(\d+)$/gm)].at(-1);
    expect(produced).toBeDefined();
    const generated = Number(produced![1]);
    // Account using input frame count: probe buffering may deliver startup frames in bursts.
    expect(frames).toBeLessThanOrEqual(
      Math.ceil(generated * Math.min(1, 3 / inputFps)),
    );
    if (inputFps === 20) expect(frames).toBeLessThan(generated / 2);
    if (inputFps === 2) expect(pixels.size).toBe(frames);
  }, 10000);
}
