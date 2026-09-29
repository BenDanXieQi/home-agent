import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { perceptionConfigSchema } from "../../src/perception/config";
import type { createVideoRuntime as Runtime } from "../../src/perception/video/runtime";

const original = {
  ...(await import("../../src/perception/media/ffmpeg-decoder")),
};
const inputs: Array<Parameters<typeof original.createFfmpegDecoder>[0]> = [];
await mock.module("../../src/perception/media/ffmpeg-decoder", () => ({
  ...original,
  createFfmpegDecoder(
    options: Parameters<typeof original.createFfmpegDecoder>[0],
  ) {
    inputs.push(options);
    const completed = Promise.withResolvers<void>();
    return {
      completed: completed.promise,
      async close() {
        completed.resolve();
      },
    };
  },
}));
afterAll(async () => {
  await mock.module(
    "../../src/perception/media/ffmpeg-decoder",
    () => original,
  );
});
beforeEach(() => {
  inputs.length = 0;
});
const { createVideoRuntime } =
  await import("../../src/perception/video/runtime");

function harness() {
  const calls: Array<{
    pixels: number[];
    result: ReturnType<typeof Promise.withResolvers<{ detections: [] }>>;
  }> = [];
  const events: Array<Parameters<Parameters<typeof Runtime>[0]["emit"]>[0]> =
    [];
  const failures: unknown[] = [];
  const listeners = new Set<() => void>();
  let enabled = true,
    busy = false;
  function wake() {
    for (const listener of listeners) listener();
  }
  const runtime = createVideoRuntime({
    compute: {
      get available() {
        return enabled && !busy;
      },
      subscribeAvailable(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async detect(frame, onAdmitted) {
        busy = true;
        const result = Promise.withResolvers<{ detections: [] }>();
        calls.push({ pixels: [...frame.rgb], result });
        try {
          await onAdmitted();
          return await result.promise;
        } finally {
          busy = false;
          wake();
        }
      },
    },
    async emit(event) {
      events.push(event);
    },
    fatal(error) {
      failures.push(error);
    },
  });
  return {
    calls,
    events,
    failures,
    start(channel: 1 | 2) {
      runtime.start({
        run: {
          deviceId: "123",
          channel,
          scopeEpoch: crypto.randomUUID(),
          runId: crypto.randomUUID(),
        },
        decoder: {
          executable: "unused",
          read: async () => new ReadableStream<Uint8Array>(),
        },
        config: perceptionConfigSchema.parse({ maxFrameAgeMs: 1000 }),
      });
    },
    frame(index: number, value: number) {
      inputs[index]!.onFrame({
        width: 1,
        height: 1,
        rgb: new Uint8Array([index, value, 0]),
      });
    },
    allow(value: boolean) {
      enabled = value;
      wake();
    },
    async close() {
      enabled = false;
      for (const call of calls) call.result.resolve({ detections: [] });
      await runtime.close();
    },
  };
}

test("after overload both cameras resume with their newest pixels, without replaying buffered frames", async () => {
  const h = harness();
  try {
    h.start(1);
    h.start(2);
    h.frame(0, 1);
    await nextTurn();
    expect(h.calls.map((call) => call.pixels)).toEqual([[0, 1, 0]]);
    for (let value = 2; value <= 100; value++) {
      h.frame(0, value);
      h.frame(1, value);
    }
    await nextTurn();
    expect(h.calls).toHaveLength(1);
    h.calls[0]!.result.resolve({ detections: [] });
    await nextTurn();
    expect(h.calls.map((call) => call.pixels)).toEqual([
      [0, 1, 0],
      [1, 100, 0],
    ]);
    h.calls[1]!.result.resolve({ detections: [] });
    await nextTurn();
    expect(h.calls.map((call) => call.pixels)).toEqual([
      [0, 1, 0],
      [1, 100, 0],
      [0, 100, 0],
    ]);
    h.calls[2]!.result.resolve({ detections: [] });
    await nextTurn();
    expect(h.calls).toHaveLength(3);
    expect(
      h.events
        .filter((event) => event.event === "settled")
        .map((event) => event.run.channel),
    ).toEqual([1, 2, 1]);
    for (const { metrics } of h.events) {
      expect(metrics.pending).toBeLessThanOrEqual(1);
      expect(metrics.inFlight).toBeLessThanOrEqual(1);
      expect(metrics.sampled).toBe(
        metrics.replaced +
          metrics.expired +
          metrics.discarded +
          metrics.submitted +
          metrics.pending,
      );
      expect(metrics.submitted).toBe(
        metrics.succeeded + metrics.failed + metrics.inFlight,
      );
    }
    expect(h.failures).toEqual([]);
  } finally {
    await h.close();
  }
});

test("a frame that expires while waiting for compute is skipped and fresh input still runs", async () => {
  let now = 100;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const h = harness();
  try {
    h.allow(false);
    h.start(1);
    h.frame(0, 1);
    await nextTurn();
    now += 1000;
    h.allow(true);
    await nextTurn();
    expect(h.calls).toHaveLength(0);
    h.frame(0, 2);
    await nextTurn();
    expect(h.calls.map((call) => call.pixels)).toEqual([[0, 2, 0]]);
    h.calls[0]!.result.resolve({ detections: [] });
    await nextTurn();
    const settled = h.events.find((event) => event.event === "settled");
    expect(settled).toMatchObject({
      sequence: 2,
      metrics: { expired: 1, submitted: 1 },
    });
    expect(h.failures).toEqual([]);
  } finally {
    await h.close();
    clock.mockRestore();
  }
});
