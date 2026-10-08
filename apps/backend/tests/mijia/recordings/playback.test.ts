import { expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HouseholdError } from "../../../src/household/errors";
import { windowSummarySchema } from "@home-agent/api/contracts";
import { createRecordingService } from "../../../src/mijia/recordings/service";
import { deferred, eventually, nextTurn } from "../../support/async";

function observation() {
  const startedAt = Math.floor(Date.now() / 1000) * 1000 - 1000;
  return windowSummarySchema.parse({
    id: crypto.randomUUID(),
    revision: 0,
    run: {
      deviceId: "test-camera",
      channel: 1,
      scopeEpoch: crypto.randomUUID(),
      runId: crypto.randomUUID(),
    },
    videoRun: null,
    generation: null,
    processingVersion: "media-window-1",
    startedAt,
    endedAt: startedAt + 1000,
    closedAt: startedAt + 1000,
    readableUntil: startedAt,
    summaryUntil: Date.now() + 60_000,
    timeBasis: "host_receive",
    synchronizationAccuracyMs: null,
    incomplete: false,
    gaps: [],
    frames: [],
    speech: {
      enabled: false,
      acceptingUntil: startedAt,
      segments: [],
      truncated: false,
    },
    audio: {
      status: "no_track",
      run: null,
      generation: null,
      startedAt: null,
      endedAt: null,
      samples: 0,
      energyBlocks: 0,
      activeEnergyBlocks: 0,
      peakRms: 0,
      speechBlocks: 0,
      vad: "unavailable",
    },
    gate: {
      candidate: "video",
      visual: "changed",
      changedRatio: 1,
      comparisons: [],
      holdUntil: null,
      audioPassed: false,
    },
    crop: null,
    inputState: "expired",
  });
}

function fixture(
  resolveWindow: NonNullable<
    Parameters<typeof createRecordingService>[0]["resolveWindow"]
  >,
  endpoint = "http://127.0.0.1/unused-recording-download",
) {
  const window = observation();
  const scopeEpoch = crypto.randomUUID();
  const source = new AbortController();
  const index = {
    source: "sd_card" as const,
    deviceId: window.run.deviceId,
    channel: window.run.channel,
    revision: "test-revision",
    timeUnit: "unix_ms" as const,
    timeBasis: "device_recording" as const,
    queriedAt: Date.now(),
    status: "ready" as const,
    recordings: [
      { startAt: window.startedAt, endAt: window.endedAt, event: false },
    ],
    totalClips: 1,
    discardedEntries: 0,
    nextAfterMs: null,
  };
  const readRecordings = mock(async () => index);
  const service = createRecordingService({
    household: { ready: true, epoch: scopeEpoch, subscribe: () => () => {} },
    mijia: {
      recordingAccess: () => ({
        signal: source.signal,
        assertCurrent() {
          source.signal.throwIfAborted();
        },
        access: {
          endpoint,
          sessionId: "test-session",
          sourceId: "test-source",
        },
      }),
      readRecordings,
    },
    shutdown: new AbortController().signal,
    resolveWindow,
  });
  const input = {
    id: crypto.randomUUID(),
    scope_epoch: scopeEpoch,
    revision: "test-revision",
    deviceId: window.run.deviceId,
    channel: window.run.channel,
    selection: { kind: "window" as const, windowId: window.id },
  };
  async function settled() {
    await eventually(() => service.state(input.id).state !== "preparing", 5000);
    return service.state(input.id);
  }
  return { service, window, source, input, index, readRecordings, settled };
}

test("missing observation is unavailable before any SD index or download request", async () => {
  const run = fixture(async () => undefined);
  try {
    run.service.request(run.input);
    expect(await run.settled()).toMatchObject({
      state: "unavailable",
      reason: "window_unavailable",
    });
    expect(run.readRecordings).not.toHaveBeenCalled();
  } finally {
    await run.service.close();
  }
});

test("archive failure is reported as an observation read failure before SD access", async () => {
  const run = fixture(async () => {
    throw new HouseholdError("home_storage");
  });
  try {
    run.service.request(run.input);
    expect(await run.settled()).toMatchObject({
      state: "unavailable",
      reason: "window_read_failed",
    });
    expect(run.readRecordings).not.toHaveBeenCalled();
  } finally {
    await run.service.close();
  }
});

test("missing SD recordings remain distinct from a failed SD index read", async () => {
  const run = fixture(() => Promise.resolve(run.window));
  try {
    run.readRecordings.mockImplementationOnce(async () => ({
      ...run.index,
      recordings: [],
    }));
    run.service.request(run.input);
    expect(await run.settled()).toMatchObject({
      state: "unavailable",
      reason: "no_matching_recording",
    });
    run.readRecordings.mockImplementationOnce(async () => {
      throw new Error("Fake camera connection failure");
    });
    const second = { ...run.input, id: crypto.randomUUID() };
    run.service.request(second);
    await eventually(() => run.service.state(second.id).state !== "preparing");
    expect(run.service.state(second.id)).toMatchObject({
      state: "unavailable",
      reason: "source_unavailable",
    });
    expect(run.readRecordings).toHaveBeenCalledTimes(2);
  } finally {
    await run.service.close();
  }
});

test("releasing playback cancels a pending observation read without accessing SD", async () => {
  const entered = deferred<AbortSignal>();
  const run = fixture((_id, signal) => {
    if (!signal) throw new Error("Expected playback cancellation signal");
    entered.resolve(signal);
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  });
  try {
    run.service.request(run.input);
    const signal = await entered.promise;
    await run.service.release(run.input.id);
    expect(signal.aborted).toBe(true);
    expect(run.service.state(run.input.id)).toMatchObject({
      state: "unavailable",
      reason: "cancelled",
    });
    expect(run.readRecordings).not.toHaveBeenCalled();
  } finally {
    await run.service.close();
  }
});

test("revoking the source during observation lookup preserves revoked playback", async () => {
  const entered = deferred();
  const lookup = deferred<ReturnType<typeof observation> | undefined>();
  const run = fixture(() => {
    entered.resolve();
    return lookup.promise;
  });
  try {
    run.service.request(run.input);
    await entered.promise;
    run.source.abort();
    lookup.reject(new HouseholdError("home_storage"));
    await nextTurn();
    expect(() => run.service.state(run.input.id)).toThrow();
    expect(run.readRecordings).not.toHaveBeenCalled();
  } finally {
    await run.service.close();
  }
});

test("a valid archived observation reaches SD playback and produces readable media", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recording-playback-test-"));
  const clip = join(directory, "input.mp4");
  const process = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=64x64:r=5",
      "-t",
      "1",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-bf",
      "0",
      clip,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const diagnostics = await new Response(process.stderr).text();
  if ((await process.exited) !== 0) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(diagnostics);
  }
  const bytes = await Bun.file(clip).arrayBuffer();
  const downloads = mock(
    () =>
      new Response(bytes, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(bytes.byteLength),
        },
      }),
  );
  const peer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: downloads });
  let resolvedSignal: AbortSignal | undefined;
  const run = fixture((id, signal) => {
    expect(id).toBe(run.window.id);
    resolvedSignal = signal;
    return Promise.resolve(run.window);
  }, peer.url.toString());
  try {
    run.service.request(run.input);
    const ready = await run.settled();
    expect(ready).toMatchObject({
      state: "ready",
      actualDurationMs: 1000,
      alignment: { type: "unknown", reason: "no_frame_mapping" },
    });
    expect(resolvedSignal?.aborted).toBe(false);
    expect(run.readRecordings).toHaveBeenCalledTimes(1);
    expect(downloads).toHaveBeenCalledTimes(1);
    const info = run.service.mediaInfo(run.input.id);
    const stream = run.service.read(
      run.input.id,
      { start: 0, end: info.bytes - 1 },
      new AbortController().signal,
    );
    expect((await new Response(stream).arrayBuffer()).byteLength).toBe(
      info.bytes,
    );
  } finally {
    await run.service.close();
    await peer.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
