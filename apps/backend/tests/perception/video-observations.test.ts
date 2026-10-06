import { expect, test } from "bun:test";
import { windowSummarySchema } from "@home-agent/api/contracts";
import { createWindowStore } from "../../src/perception/window/store";
import { perceptionConfigSchema } from "../../src/perception/config";
import { createVideoMetrics } from "../../src/perception/video/metrics";
import { windowLimits } from "../../src/perception/window/limits";

function capture() {
  const run = {
    deviceId: "123",
    channel: 1 as const,
    scopeEpoch: crypto.randomUUID(),
    runId: crypto.randomUUID(),
  };
  const generation = crypto.randomUUID();
  let allowed = true;
  const store = createWindowStore({
    config: () => perceptionConfigSchema.parse({}),
    authorized: () => allowed,
  });
  store.reconcile(
    [{ source: run, scopeEpoch: run.scopeEpoch, identity: "current" }],
    8000,
  );
  store.bindVideo(run);
  function frame(sequence: number) {
    return {
      sequence,
      receivedAt: 7000 + sequence * 1000,
      mediaTime: {
        generation,
        pts: sequence * 90000,
        rtpTimestamp: sequence * 90000,
        timeBaseNumerator: 1 as const,
        timeBaseDenominator: 90000 as const,
        quality: "source_media" as const,
      },
      width: 640,
      height: 480,
      retainedWidth: 2,
      retainedHeight: 2,
      rgb: new Uint8Array(12),
      gray: new Uint8Array(windowLimits.graySide ** 2).fill(
        sequence === 1 ? 0 : 255,
      ),
    };
  }
  function events(value = frame(2)) {
    const observation = {
      run,
      sequence: value.sequence,
      receivedAt: value.receivedAt,
      sampledAt: value.receivedAt,
      mediaTime: value.mediaTime,
      width: value.width,
      height: value.height,
      coordinateBasis: "decoded_rgb24" as const,
      ageMs: 10,
      detections: [
        {
          x: 1,
          y: 1,
          w: 20,
          h: 20,
          classId: 0,
          className: "human" as const,
          confidence: 0.9,
        },
      ],
    };
    return {
      detection: {
        event: "settled" as const,
        run,
        sequence: value.sequence,
        metrics: createVideoMetrics().snapshot(),
        observation,
      },
      tracking: {
        event: "tracking" as const,
        run,
        observation: {
          ...observation,
          status: "tracked" as const,
          skippedFrames: 0,
          omittedHumans: 0,
          omittedPets: 0,
          tracks: [],
        },
      },
      identity: {
        event: "identity_frame" as const,
        run,
        frame: value,
        identity: {
          status: "disabled" as const,
          evaluatedAt: 9100,
          inference: "not_requested" as const,
          referenceVersions: null,
          tracks: [],
        },
      },
    };
  }
  function addFrame(sequence: number) {
    store.video(
      { event: "window_frame", run, frame: frame(sequence), skipped: 0 },
      9100,
    );
  }
  return {
    run,
    store,
    frame,
    events,
    addFrame,
    revoke() {
      allowed = false;
    },
    summary() {
      const [window] = store.snapshot(12600, run).windows;
      return windowSummarySchema.parse(store.describe(window!.id, 12600));
    },
  };
}

for (const beforeFrame of [true, false]) {
  test(`video analyzers associate the exact frame ${beforeFrame ? "before" : "after"} pixel delivery and freeze duplicate judgments`, () => {
    const run = capture();
    try {
      run.addFrame(1);
      const events = run.events();
      if (!beforeFrame) run.addFrame(2);
      for (const event of Object.values(events)) run.store.video(event, 9100);
      if (beforeFrame) run.addFrame(2);
      run.store.video(
        {
          ...events.detection,
          observation: { ...events.detection.observation, detections: [] },
        },
        9200,
      );
      run.store.video(
        {
          ...events.identity,
          identity: { ...events.identity.identity, status: "unavailable" },
        },
        9200,
      );
      const frame = run.summary().frames.find((item) => item.sequence === 2)!;
      expect(frame.detections).toHaveLength(1);
      expect(frame.tracks).toEqual([]);
      expect(frame.identity?.status).toBe("disabled");
    } finally {
      run.store.close();
    }
  });
}

test("matching PTS and sequence alone cannot attach results with the wrong dimensions, clock or nested run", () => {
  const run = capture();
  try {
    run.addFrame(1);
    run.addFrame(2);
    for (const badFrame of [
      { ...run.frame(2), width: 1280 },
      { ...run.frame(2), receivedAt: 9001 },
      {
        ...run.frame(2),
        mediaTime: {
          ...run.frame(2).mediaTime,
          generation: crypto.randomUUID(),
        },
      },
    ])
      for (const event of Object.values(run.events(badFrame)))
        run.store.video(event, 9100);
    const event = run.events().detection;
    run.store.video(
      {
        ...event,
        observation: {
          ...event.observation,
          run: { ...run.run, runId: crypto.randomUUID() },
        },
      },
      9100,
    );
    const frame = run.summary().frames.find((item) => item.sequence === 2)!;
    expect(frame.detections).toBeNull();
    expect(frame.tracks).toBeNull();
    expect(frame.identity).toBeNull();
  } finally {
    run.store.close();
  }
});

test("every video analyzer obeys the same closure deadline even if the window timer has not run", () => {
  const run = capture();
  try {
    run.addFrame(1);
    run.addFrame(2);
    for (const event of Object.values(run.events()))
      run.store.video(event, 12500);
    const frame = run.summary().frames.find((item) => item.sequence === 2)!;
    expect(frame.detections).toBeNull();
    expect(frame.tracks).toBeNull();
    expect(frame.identity).toBeNull();
    expect(run.store.snapshot(12600, run.run).counters.lateObservations).toBe(
      3,
    );
  } finally {
    run.store.close();
  }
});

test("replacement runs and revoked sources cannot write observations into retained frames", () => {
  const run = capture();
  try {
    run.addFrame(1);
    run.addFrame(2);
    run.store.bindVideo({ ...run.run, runId: crypto.randomUUID() });
    for (const event of Object.values(run.events()))
      run.store.video(event, 9100);
    const frame = run.summary().frames.find((item) => item.sequence === 2)!;
    expect(frame.detections).toBeNull();
    expect(frame.identity).toBeNull();
    run.revoke();
    run.store.tick(12601);
    expect(run.store.snapshot(12601, run.run).windows).toEqual([]);
    expect(run.store.snapshot(12601, run.run).retainedBytes).toBe(0);
  } finally {
    run.store.close();
  }
});

test("delayed pixel delivery also obeys the admission deadline before the close timer runs", () => {
  const run = capture();
  try {
    run.addFrame(1);
    run.store.video(
      { event: "window_frame", run: run.run, frame: run.frame(2), skipped: 0 },
      12500,
    );
    const snapshot = run.store.snapshot(12600, run.run);
    expect(snapshot.windows).toEqual([]);
    expect(snapshot.counters.droppedFrames).toBe(1);
  } finally {
    run.store.close();
  }
});
