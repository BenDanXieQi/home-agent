import { describe, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { createFrameAssembler } from "../../src/perception/media/frame-assembler";
import { createObservationStore } from "../../src/perception/observation-store";
import { createVideoMetrics } from "../../src/perception/video/metrics";
import { perceptionConfigSchema } from "../../src/perception/config";

const run = {
  deviceId: "123",
  channel: 1 as const,
  scopeEpoch: crypto.randomUUID(),
  runId: crypto.randomUUID(),
};
function observation(sequence: number, ageMs = 0) {
  return {
    run,
    sequence,
    receivedAt: Date.now() - ageMs,
    sampledAt: Date.now() - ageMs,
    mediaTime: null,
    width: 2,
    height: 1,
    coordinateBasis: "decoded_rgb24" as const,
    detections: [],
    ageMs,
  };
}
function event(sequence: number, ageMs = 0) {
  return {
    event: "settled" as const,
    run,
    sequence,
    observation: observation(sequence, ageMs),
    metrics: createVideoMetrics().snapshot(),
  };
}
describe("P1 frame and scheduling boundaries", () => {
  test("PPM frames survive arbitrary splits, including header-looking RGB bytes", () => {
    const frames: Uint8Array[] = [];
    const assembler = createFrameAssembler((frame) => {
      frames.push(frame.rgb);
    });
    const pixels = new Uint8Array([80, 54, 10, 32, 255, 0]);
    const stream = Buffer.concat([
      Buffer.from("P6\n2 1\n255\n"),
      pixels,
      Buffer.from("P6\n2 1\n255\n"),
      pixels,
    ]);
    for (const byte of stream) assembler.push(new Uint8Array([byte]));
    expect(frames).toEqual([pixels, pixels]);
    expect(frames[0]).not.toBe(frames[1]);
    expect(() => assembler.push(Buffer.from("P6\n8192 8192\n255\n"))).toThrow(
      "limits",
    );
    assembler.clear();
  });
  test("duplicate channels are rejected without rejecting two channels of one camera", () => {
    expect(() =>
      perceptionConfigSchema.parse({
        sources: [
          { deviceId: "1", channel: 1 },
          { deviceId: "1", channel: 1 },
        ],
      }),
    ).toThrow();
    expect(
      perceptionConfigSchema.safeParse({
        sources: [
          { deviceId: "1", channel: 1 },
          { deviceId: "1", channel: 2 },
        ],
      }).success,
    ).toBe(true);
  });
  test("silence timeout must exceed the sampling interval to avoid false outages", () => {
    expect(() =>
      perceptionConfigSchema.parse({ sampleFps: 0.1, silenceTimeoutMs: 10000 }),
    ).toThrow("Silence timeout");
    expect(
      perceptionConfigSchema.parse({ sampleFps: 0.1, silenceTimeoutMs: 30000 })
        .sampleFps,
    ).toBe(0.1);
  });
});
describe("P1 observation qualification", () => {
  test("successful empty detections expire without another media event", async () => {
    const store = createObservationStore(60);
    let updates = 0;
    store.subscribe(() => {
      updates++;
    });
    try {
      store.grant(run);
      store.receive(event(1));
      expect(store.snapshot()[0]?.validity).toBe("valid");
      const before = updates;
      await delay(110);
      expect(store.snapshot()[0]?.validity).toBe("expired");
      expect(updates).toBeGreaterThan(before);
    } finally {
      store.close();
    }
  });
  test("expired results and out-of-order completions cannot overwrite current evidence", () => {
    const store = createObservationStore(2000);
    try {
      store.grant(run);
      store.receive(event(2));
      store.receive(event(1));
      store.receive(event(3, 3000));
      expect(store.snapshot()[0]?.observation?.sequence).toBe(2);
      expect(store.snapshot()[0]?.metrics).toMatchObject({
        published: 1,
        rejected: 1,
        expiredResults: 1,
      });
    } finally {
      store.close();
    }
  });
  test("revocation fences both health and results, including after a replacement run", () => {
    const store = createObservationStore(2000);
    try {
      store.grant(run);
      store.receive(event(1));
      store.revoke("123:1", "revoked");
      store.receive(event(2));
      expect(store.snapshot()[0]?.validity).toBe("unavailable");
      const next = { ...run, runId: crypto.randomUUID() };
      store.grant(next);
      store.receive({
        event: "health",
        run,
        status: "failed",
        error: "old",
        metrics: createVideoMetrics().snapshot(),
      });
      store.receive(event(3));
      expect(store.rejectedRetiredResults).toBe(2);
      expect(store.snapshot()[0]).toMatchObject({
        run: next,
        status: "starting",
        validity: "no_data",
        observation: null,
      });
    } finally {
      store.close();
    }
  });
});
