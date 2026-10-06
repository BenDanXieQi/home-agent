import { expect, test } from "bun:test";
import {
  petSoundObservationSchema,
  speechObservationSchema,
  windowSummarySchema,
  windowSpeechSegmentLimit,
} from "@home-agent/api/contracts";
import { createWindowStore } from "../../src/perception/window/store";
import { perceptionConfigSchema } from "../../src/perception/config";
import { initialAudioTrack } from "../../src/perception/audio/protocol";
import { windowLimits } from "../../src/perception/window/limits";
import { petSoundDeliveryDeadline } from "../../src/perception/pet-sound/limits";

function capture(pets = true, speech = true) {
  const config = perceptionConfigSchema.parse({
    petSounds: { enabled: pets },
    speech: { enabled: speech },
  });
  const scopeEpoch = crypto.randomUUID();
  const selection = { deviceId: "123", channel: 1 as const, scopeEpoch };
  const run = { deviceId: "123", scopeEpoch, trackRunId: crypto.randomUUID() };
  const generation = crypto.randomUUID();
  let allowed = true;
  const store = createWindowStore({
    config: () => config,
    authorized: () => allowed,
  });
  const notified: string[] = [];
  store.subscribe((id) => {
    notified.push(id);
  });
  store.reconcile(
    [{ source: selection, scopeEpoch, identity: "authorized" }],
    8000,
  );
  const initial = initialAudioTrack({ run, channels: [1] });
  function pcm(from: number, until: number) {
    for (let start = from; start < until; start += 32) {
      const samples = Math.round((Math.min(start + 32, until) - start) * 16);
      store.audio(
        {
          ...initial,
          generation,
          status: "reading",
          validity: "valid",
          samples: (start - 8000) * 16 + samples,
          sequence: (start - 8000) / 32 + 1,
          observedAt: start,
          receivedAt: start + samples / 16,
          petSounds: pets
            ? {
                status: "insufficient_input",
                modelSha256: "a".repeat(64),
                chunks: [],
                dropped: 0,
                validity: "no_data",
              }
            : undefined,
        },
        new Int16Array(samples).fill(100),
      );
    }
  }
  function pet(start = 8000, end = 12000) {
    return petSoundObservationSchema.parse({
      id: `${run.trackRunId}:${start}:${end}`,
      run,
      generation,
      startSample: (start - 8000) * 16,
      endSample: (end - 8000) * 16,
      observedStartAt: start,
      observedEndAt: end,
      completedAt: end + 800,
      modelSha256: "a".repeat(64),
      processingVersion: "zipformer-pet-overlap",
      inferenceMs: 30,
      detections: [{ kind: "dog", label: "Bark", score: 0.9 }],
    });
  }
  function voice() {
    return speechObservationSchema.parse({
      ...pet(),
      text: "hello",
      speechEndSample: 64000,
      boundary: "pause",
      processingVersion: "sensevoice-silero-frame-processor",
    });
  }
  return {
    store,
    selection,
    config,
    pcm,
    pet,
    voice,
    notified,
    revoke() {
      allowed = false;
    },
    snapshot(now = 12800) {
      return store.snapshot(now, selection);
    },
  };
}

for (const kind of ["speech", "pet_sound"] as const) {
  test(`${kind}: a late independent observation promotes retained PCM exactly once`, () => {
    const run = capture(kind === "pet_sound", kind === "speech");
    try {
      run.pcm(8000, 12000);
      expect(run.snapshot(12501).windows).toEqual([]);
      expect(run.notified).toEqual([]);
      const deliver = () =>
        kind === "speech"
          ? run.store.speech(run.voice(), 12800)
          : run.store.petSound(run.pet(), 12800);
      deliver();
      const [window] = run.snapshot().windows;
      expect(window?.gate.candidate).toBe("audio");
      if (kind === "pet_sound") expect(window?.gate.audioPassed).toBe(true);
      expect(run.notified).toEqual([window!.id]);
      const summary = windowSummarySchema.parse(
        run.store.describe(window!.id, 12800),
      );
      expect(
        kind === "speech"
          ? summary.speech.segments.length
          : summary.audio.petSounds?.chunks.length,
      ).toBe(1);
      const input = run.store.acquire(window!.id, 12800)!;
      expect(
        input.input.audio.reduce((sum, block) => sum + block.pcm.length, 0),
      ).toBe(64000);
      const before = run.snapshot();
      deliver();
      expect(run.snapshot().summaryBytes).toBe(before.summaryBytes);
      expect(run.snapshot().windows[0]?.revision).toBe(window!.revision);
      expect(run.notified).toHaveLength(1);
    } finally {
      run.store.close();
    }
  });
}

test("overlapping pet context belongs to its completion window and remains fully audible", () => {
  const run = capture();
  try {
    run.pcm(8000, 12000);
    run.snapshot(12501);
    run.pcm(12000, 16000);
    run.snapshot(16501);
    run.store.petSound(run.pet(10000, 14000), 16800);
    const snapshot = run.snapshot(16800);
    expect(snapshot.windows).toHaveLength(1);
    const window = snapshot.windows[0]!;
    expect(window.startedAt).toBe(12000);
    const summary = run.store.describe(window.id, 16800)!;
    expect(summary.audio.petSounds?.chunks[0]?.observedStartAt).toBe(10000);
    expect(summary.audio.startedAt).toBeLessThanOrEqual(10000);
    const input = run.store.acquire(window.id, 16800)!;
    expect(input.input.audio[0]?.startedAt).toBe(8000);
    expect(
      input.input.audio.reduce((sum, block) => sum + block.pcm.length, 0),
    ).toBe(128000);
    expect(snapshot.retainedBytes).toBeLessThanOrEqual(windowLimits.inputBytes);
  } finally {
    run.store.close();
  }
});

test("invalid identities and empty detections cannot admit a window; revocation rejects delayed results", () => {
  const run = capture();
  try {
    run.pcm(8000, 12000);
    run.snapshot(12501);
    const pet = run.pet();
    run.store.petSound({ ...pet, generation: crypto.randomUUID() }, 12800);
    run.store.petSound(
      { ...pet, run: { ...pet.run, trackRunId: crypto.randomUUID() } },
      12800,
    );
    run.store.petSound(
      { ...pet, run: { ...pet.run, scopeEpoch: crypto.randomUUID() } },
      12800,
    );
    run.store.petSound({ ...pet, detections: [] }, 12800);
    expect(run.snapshot().windows).toEqual([]);
    run.revoke();
    run.store.petSound({ ...pet, id: "after-revocation" }, 12801);
    run.store.speech(run.voice(), 12801);
    expect(run.snapshot(12801).windows).toEqual([]);
    expect(run.snapshot(12801).retainedBytes).toBe(0);
    expect(run.notified).toEqual([]);
  } finally {
    run.store.close();
  }
});

test("source replacement cannot use an old context to capture the new run", () => {
  const run = capture();
  try {
    run.pcm(8000, 12000);
    run.snapshot(12501);
    run.store.reconcile([], 12501);
    const selection = { ...run.selection, scopeEpoch: crypto.randomUUID() };
    run.store.reconcile(
      [
        {
          source: selection,
          scopeEpoch: selection.scopeEpoch,
          identity: "new",
        },
      ],
      12502,
    );
    run.store.petSound(run.pet(), 12800);
    expect(run.store.snapshot(12800, selection).windows).toEqual([]);
  } finally {
    run.store.close();
  }
});

test("late history never resurrects expired media and expired analysis cannot create history", () => {
  const run = capture(true, false);
  try {
    run.pcm(8000, 12000);
    run.snapshot(12501);
    run.store.petSound(run.pet(), 25000);
    const window = run.snapshot(25000).windows[0]!;
    expect(window.inputState).toBe("expired");
    expect(run.store.acquire(window.id, 25000)).toBeUndefined();
    expect(run.notified).toEqual([]);
  } finally {
    run.store.close();
  }
  const expired = capture(true, false);
  try {
    expired.pcm(8000, 12000);
    expired.snapshot(12501);
    const after = petSoundDeliveryDeadline(12000, expired.config.maxFrameAgeMs);
    expired.store.petSound(expired.pet(), after);
    expect(expired.snapshot(after).windows).toEqual([]);
  } finally {
    expired.store.close();
  }
});

test("pending audio remains bounded and an admitted read is cancelled by access revocation", () => {
  const run = capture();
  try {
    for (let start = 8000; start < 40000; start += 4000) {
      run.pcm(start, start + 4000);
      const snapshot = run.snapshot(start + 4501);
      expect(snapshot.windows).toEqual([]);
      expect(snapshot.retainedBytes).toBeLessThanOrEqual(
        (windowLimits.readyPerSource * 8000 + 4000) * 32,
      );
    }
    run.store.petSound(run.pet(36000, 40000), 44800);
    const window = run.snapshot(44800).windows[0]!;
    const read = run.store.acquireRead(window.id, 44800)!;
    expect(read.signal.aborted).toBe(false);
    run.revoke();
    run.store.tick(44801);
    expect(read.signal.aborted).toBe(true);
    expect(run.snapshot(44801).retainedBytes).toBe(0);
    read.release();
  } finally {
    run.store.close();
  }
});

test("a hole in retained analysis context cannot be hidden by a fully covered nominal window", () => {
  const run = capture(true, false);
  try {
    run.pcm(8000, 10000);
    run.pcm(10032, 12000);
    run.snapshot(12501);
    run.pcm(12000, 16000);
    run.snapshot(16501);
    run.store.petSound(run.pet(9000, 13000), 16800);
    expect(run.snapshot(16800).windows).toEqual([]);
    expect(run.notified).toEqual([]);
  } finally {
    run.store.close();
  }
});

for (const offset of [-1 / 16, 0, 1 / 16]) {
  test(`pet result ending ${offset} ms from a boundary belongs to exactly one window`, () => {
    const run = capture(true, false);
    try {
      run.pcm(8000, 12000);
      run.snapshot(12501);
      run.pcm(12000, 16000);
      run.snapshot(16501);
      const observation = run.pet();
      observation.observedStartAt += offset;
      observation.observedEndAt += offset;
      run.store.petSound(observation, 16800);
      run.store.petSound(observation, 16801);
      const snapshot = run.snapshot(16801);
      expect(snapshot.windows).toHaveLength(1);
      const window = snapshot.windows[0]!;
      expect(window.startedAt).toBe(offset > 0 ? 12000 : 8000);
      expect(run.notified).toEqual([window.id]);
      expect(
        run.store.describe(window.id, 16801)?.audio.petSounds?.chunks,
      ).toHaveLength(1);
    } finally {
      run.store.close();
    }
  });
}

test("late audio accounting equals full summary bytes across admission, truncation and expiry", () => {
  const run = capture();
  try {
    run.pcm(8000, 12000);
    run.snapshot(12501);
    run.store.petSound(run.pet(), 12800);
    const checkBytes = (now: number) => {
      const snapshot = run.snapshot(now);
      expect(snapshot.windows).toHaveLength(1);
      expect(snapshot.summaryBytes).toBe(
        snapshot.windows.reduce(
          (sum, window) =>
            sum +
            Buffer.byteLength(
              JSON.stringify(run.store.describe(window.id, now)),
            ),
          0,
        ),
      );
      return snapshot.summaryBytes;
    };
    const admittedBytes = checkBytes(12800);
    run.store.petSound(run.pet(), 12800);
    run.store.petSound(
      { ...run.pet(), id: "wrong-generation", generation: crypto.randomUUID() },
      12800,
    );
    expect(checkBytes(12800)).toBe(admittedBytes);
    for (let index = 0; index <= windowSpeechSegmentLimit; index++) {
      run.store.speech(
        {
          ...run.voice(),
          id: `voice-${index}`,
          text: `小狗在叫，第${index}段。`,
        },
        12800,
      );
      checkBytes(12800);
    }
    const [window] = run.snapshot().windows;
    expect(run.store.describe(window!.id, 12800)?.speech.truncated).toBe(true);
    checkBytes(25000);
    expect(run.store.describe(window!.id, 25000)?.inputState).toBe("expired");
    run.store.petSound({ ...run.pet(), id: "late-after-expiry" }, 25000);
    checkBytes(25000);
  } finally {
    run.store.close();
  }
});
