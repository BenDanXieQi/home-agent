import { trackingObservationSchema } from "@home-agent/api/contracts";
import { expect, spyOn, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { createTrackingRuntime } from "../../src/perception/tracking/runtime";
import { createObservationStore } from "../../src/perception/observation-store";
import { createVideoMetrics } from "../../src/perception/video/metrics";
const run = () => ({
  deviceId: "camera",
  channel: 1 as const,
  runId: crypto.randomUUID(),
  scopeEpoch: crypto.randomUUID(),
});
const detection = {
  x: 0,
  y: 0,
  w: 2,
  h: 2,
  confidence: 0.9,
  classId: 0,
  className: "human" as const,
};
const frame = (sequence = 1) => ({
  width: 2,
  height: 2,
  rgb: new Uint8Array(12).fill(42),
  availableAt: performance.now(),
  receivedAt: Date.now(),
  sequence,
});
function harness() {
  const output: Parameters<
    Parameters<typeof createTrackingRuntime>[0]["emit"]
  >[0][] = [];
  const failure: unknown[] = [];
  const result = Promise.withResolvers<number[][]>();
  let input:
    | Parameters<
        Parameters<typeof createTrackingRuntime>[0]["model"]["extract"]
      >[0]
    | undefined;
  let busy = false;
  let modelStarts = 0;
  const runtime = createTrackingRuntime({
    reserveCompute: () => true,
    model: {
      start() {
        modelStarts++;
      },
      get status() {
        return { ready: true, busy, error: undefined, pid: undefined };
      },
      extract(value) {
        input = value;
        busy = true;
        return result.promise.finally(() => {
          busy = false;
        });
      },
      async close() {
        result.resolve([]);
      },
    },
    async emit(value) {
      output.push(value);
    },
    failure(value) {
      failure.push(value);
    },
  });
  return {
    runtime,
    output,
    result,
    failure,
    get modelStarts() {
      return modelStarts;
    },
    get input() {
      return input;
    },
  };
}
test("retained pixels survive detector transfer; publication is independent and bounded", async () => {
  const h = harness(),
    source = run();
  h.runtime.start(source);
  try {
    const original = frame();
    const retained = h.runtime.capture(source, original, 2000)!;
    structuredClone(original.rgb, { transfer: [original.rgb.buffer] });
    retained.complete([detection]);
    expect(h.input?.frame.rgb[0]).toBe(42);
    expect(h.runtime.capture(source, frame(2), 2000)).toBeUndefined();
    expect(h.output).toHaveLength(0);
    h.result.resolve([
      Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0)),
    ]);
    await setImmediate();
    expect(h.output[0]).toMatchObject({
      status: "tracked",
      skippedFrames: 1,
      tracks: [{ feature: "extracted" }],
    });
    expect(h.failure).toEqual([]);
  } finally {
    await h.runtime.close();
  }
});
test("stopped source cannot publish late appearance results", async () => {
  const h = harness(),
    source = run();
  h.runtime.start(source);
  h.runtime.capture(source, frame(), 2000)!.complete([detection]);
  h.runtime.stop(source.runId);
  h.result.resolve([Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0))]);
  await setImmediate();
  expect(h.output).toHaveLength(0);
  await h.runtime.close();
});
test("prediction preserves original evidence times across host clock corrections", async () => {
  const h = harness();
  const source = run();
  h.runtime.start(source);
  try {
    const original = frame();
    h.runtime
      .capture(source, original, 2000)!
      .complete([detection, { ...detection, className: "cat", classId: 1 }]);
    h.result.resolve([
      Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0)),
    ]);
    await setImmediate();
    for (const [index, offset] of [60_000, -60_000].entries()) {
      const next = {
        ...frame(index + 2),
        receivedAt: original.receivedAt + offset,
      };
      h.runtime.capture(source, next, 2000)!.complete([]);
      await setImmediate();
      const result = trackingObservationSchema.parse(h.output.at(-1));
      expect(result).toMatchObject({
        receivedAt: next.receivedAt,
        sampledAt: next.receivedAt,
        mediaTime: null,
      });
      expect(result.tracks).toHaveLength(2);
      for (const track of result.tracks) {
        expect(track.state).toBe("predicted");
        expect(track.measuredBox).toBeNull();
        expect(track.lastMeasuredAt).toBe(original.receivedAt);
        expect(track.featureAt).toBe(
          track.className === "human" ? original.receivedAt : null,
        );
      }
    }
    const measured = frame(4);
    h.runtime
      .capture(source, measured, 2000)!
      .complete([{ ...detection, className: "cat", classId: 1 }]);
    await setImmediate();
    expect(
      h.output.at(-1)?.tracks.find((track) => track.className === "cat"),
    ).toMatchObject({ state: "measured", lastMeasuredAt: measured.receivedAt });
    expect(h.failure).toEqual([]);
  } finally {
    await h.runtime.close();
  }
});
test("appearance failure still produces measured geometry with missing features", async () => {
  const h = harness(),
    source = run();
  h.runtime.start(source);
  h.runtime.capture(source, frame(), 2000)!.complete([detection]);
  h.result.reject(new Error("model failure"));
  await setImmediate();
  expect(h.output[0]).toMatchObject({
    status: "degraded",
    tracks: [{ state: "measured", feature: "missing" }],
  });
  await h.runtime.close();
});
test("only two retained frames across sources and expired pixels are not submitted", async () => {
  const h = harness(),
    sources = [run(), run(), run()];
  sources.forEach((source) => {
    h.runtime.start(source);
  });
  const a = h.runtime.capture(sources[0]!, frame(), 2000)!;
  const b = h.runtime.capture(sources[1]!, frame(), 2000)!;
  const geometry = h.runtime.capture(sources[2]!, frame(), 2000)!;
  geometry.complete([detection]);
  await setImmediate();
  expect(h.input).toBeUndefined();
  expect(h.output[0]).toMatchObject({
    status: "degraded",
    tracks: [{ state: "measured", feature: "missing" }],
  });
  h.runtime.stop(sources[0]!.runId);
  const replacement = h.runtime.capture(sources[2]!, frame(), 2000);
  expect(replacement).toBeDefined();
  replacement!.release();
  a.release();
  b.release();
  h.runtime.start(sources[0]!);
  const stale = { ...frame(), availableAt: performance.now() - 3000 };
  h.runtime.capture(sources[0]!, stale, 2000)!.complete([detection]);
  await setImmediate();
  expect(h.input).toBeUndefined();
  expect(h.output).toHaveLength(1);
  await h.runtime.close();
});
test("tracking store rejects retired, out-of-order and expired results independently of detection", () => {
  const store = createObservationStore(2000),
    source = run();
  store.grant(source);
  const observation = {
    run: source,
    sequence: 2,
    receivedAt: Date.now(),
    sampledAt: Date.now(),
    mediaTime: null,
    ageMs: 0,
    width: 2,
    height: 2,
    coordinateBasis: "decoded_rgb24" as const,
    status: "tracked" as const,
    tracks: [],
    skippedFrames: 0,
    omittedHumans: 0,
    omittedPets: 0,
  };
  try {
    store.receive({ event: "tracking", run: source, observation });
    store.receive({
      event: "tracking",
      run: source,
      observation: { ...observation, sequence: 1 },
    });
    store.receive({
      event: "tracking",
      run: source,
      observation: { ...observation, sequence: 3, ageMs: 2000 },
    });
    expect(store.snapshot()[0]).toMatchObject({
      validity: "no_data",
      trackingValidity: "valid",
      tracking: { sequence: 2 },
    });
    store.receive({
      event: "health",
      run: source,
      status: "failed",
      metrics: createVideoMetrics().snapshot(),
    });
    expect(store.snapshot()[0]?.trackingValidity).toBe("unavailable");
    store.receive({
      event: "tracking",
      run: source,
      observation: { ...observation, sequence: 4 },
    });
    expect(store.snapshot()[0]?.trackingValidity).toBe("unavailable");
    store.grant({ ...source, runId: crypto.randomUUID() });
    store.receive({ event: "tracking", run: source, observation });
    expect(store.snapshot()[0]?.tracking).toBeNull();
  } finally {
    store.close();
  }
});

test("pet-only input publishes typed tracks without starting human appearance compute", async () => {
  const h = harness(),
    source = run();
  h.runtime.start(source);
  try {
    h.runtime.capture(source, frame(), 2000)!.complete([
      { ...detection, className: "cat", classId: 1 },
      { ...detection, className: "dog", classId: 2 },
    ]);
    await setImmediate();
    const result = trackingObservationSchema.parse(h.output[0]);
    expect(result.status).toBe("tracked");
    expect(result.tracks.map((t) => t.className)).toEqual(["cat", "dog"]);
    expect(
      result.tracks.every(
        (t) => t.feature === "not_applicable" && t.featureAt === null,
      ),
    ).toBe(true);
    expect(result.omittedPets).toBe(0);
    expect(result.omittedHumans).toBe(0);
    expect(h.modelStarts).toBe(0);
    expect(h.input).toBeUndefined();
  } finally {
    await h.runtime.close();
  }
});
test("mixed human and pet input shares unique ids and sends only human crops to ReID", async () => {
  const h = harness(),
    source = run();
  h.runtime.start(source);
  try {
    h.runtime
      .capture(source, frame(), 2000)!
      .complete([
        detection,
        { ...detection, className: "cat", classId: 1 },
        { ...detection, className: "dog", classId: 2 },
      ]);
    expect(h.input?.boxes).toEqual([detection]);
    h.result.resolve([
      Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0)),
    ]);
    await setImmediate();
    const result = trackingObservationSchema.parse(h.output[0]);
    expect(result.tracks.map((t) => t.className)).toEqual([
      "human",
      "cat",
      "dog",
    ]);
    expect(new Set(result.tracks.map((t) => t.trackId)).size).toBe(3);
    expect(result.omittedHumans).toBe(0);
    expect(result.omittedPets).toBe(0);
  } finally {
    await h.runtime.close();
  }
});
test("pet overflow is reported independently from human omission", async () => {
  const h = harness(),
    source = run();
  h.runtime.start(source);
  try {
    h.runtime.capture(source, frame(), 2000)!.complete(
      Array.from({ length: 10 }, () => ({
        ...detection,
        className: "cat" as const,
        classId: 1,
      })),
    );
    await setImmediate();
    expect(trackingObservationSchema.parse(h.output[0])).toMatchObject({
      omittedPets: 2,
      omittedHumans: 0,
    });
    expect(h.output[0]?.tracks).toHaveLength(8);
  } finally {
    await h.runtime.close();
  }
});

test("synchronized camera bursts do not permanently starve a pet-only source", async () => {
  const h = harness();
  const sources = [run(), run(), run()];
  for (const source of sources) h.runtime.start(source);
  try {
    for (let sequence = 1; sequence <= 6; sequence++) {
      // Three detector slots accept this burst before any detector completes.
      // Stable camera arrival order repeats at the configured sampling period.
      const captures = sources.map((source) =>
        h.runtime.capture(source, frame(sequence), 2000),
      );
      for (const capture of captures)
        capture?.complete([{ ...detection, className: "cat", classId: 1 }]);
      await setImmediate();
    }
    expect(h.modelStarts).toBe(0);
    for (const source of sources) {
      expect(
        h.output.some(
          (result) =>
            result.run.runId === source.runId && result.tracks.length > 0,
        ),
      ).toBe(true);
    }
  } finally {
    await h.runtime.close();
  }
});

test("appearance pixels rotate across synchronized sources without blocking geometry", async () => {
  const h = harness();
  const sources = [run(), run(), run()];
  for (const source of sources) h.runtime.start(source);
  h.result.resolve([Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0))]);
  try {
    for (let sequence = 1; sequence <= 9; sequence++) {
      const captures = sources.map((source) =>
        h.runtime.capture(source, frame(sequence), 2000),
      );
      for (const capture of captures) capture!.complete([detection]);
      await setImmediate();
    }
    for (const source of sources) {
      const results = h.output.filter((r) => r.run.runId === source.runId);
      expect(results).toHaveLength(9);
      expect(
        results.some((r) => r.tracks.some((t) => t.feature === "extracted")),
      ).toBe(true);
      expect(results.every((r) => r.skippedFrames === 0)).toBe(true);
    }
  } finally {
    await h.runtime.close();
  }
});

test("stopped or expired pixel eligibility cannot block an active source", async () => {
  let now = 1000;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  try {
    for (const retirement of ["stop", "expire"]) {
      const h = harness();
      const sources = [run(), run(), run(), run()];
      for (const source of sources) h.runtime.start(source);
      h.result.resolve([
        Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0)),
      ]);
      try {
        const first = h.runtime.capture(sources[0]!, frame(), 2000)!;
        const second = h.runtime.capture(sources[1]!, frame(), 2000)!;
        h.runtime.capture(sources[2]!, frame(), 10)!.release();
        if (retirement === "stop") h.runtime.stop(sources[2]!.runId);
        else now += 11;
        first.release();
        second.release();
        h.runtime.capture(sources[3]!, frame(), 2000)!.complete([detection]);
        await setImmediate();
        expect(h.input).toBeDefined();
        expect(h.output[0]?.tracks[0]?.feature).toBe("extracted");
      } finally {
        await h.runtime.close();
      }
    }
  } finally {
    clock.mockRestore();
  }
});
