import { expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HouseholdError } from "../../../src/household/errors";
import { windowSummarySchema } from "@home-agent/api/contracts";
import { createRecordingService } from "../../../src/mijia/recordings/service";
import { createSdRecordingSource } from "../../../src/mijia/recordings/source";
import { createRecordingsService } from "../../../src/recordings/service";
import { perceptionConfigSchema } from "../../../src/perception/config";
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

async function fixture(
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
  const shutdown = new AbortController().signal;
  const sd = createSdRecordingSource({
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
      sourceSnapshot() {
        throw new Error("Current binding lookup is not used by playback");
      },
    },
    shutdown,
  });
  const directory = await mkdtemp(join(tmpdir(), "recording-playback-test-"));
  const originals = createRecordingsService({
    sd,
    sources: {
      list: () => [],
      subscribe: () => () => {},
      eligibility: () =>
        source.signal.aborted
          ? null
          : {
              scopeEpoch,
              householdVersion: { scope_epoch: scopeEpoch, sequence: 0 },
              identity: "test-source",
            },
      prepare() {
        throw new Error("Live capture is not used by playback");
      },
    },
    readConfig: async () => perceptionConfigSchema.parse({ cpuRatio: 0.5 }),
    executable: "ffmpeg",
    directory: join(directory, "originals"),
  });
  await originals.start();
  const playback = createRecordingService({
    household: { ready: true, epoch: scopeEpoch, subscribe: () => () => {} },
    sd,
    originals,
    shutdown,
    resolveWindow,
    directory: join(directory, "playback"),
  });
  const service = {
    ...playback,
    async close() {
      await playback.close();
      await originals.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
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
  return {
    service,
    originals,
    window,
    source,
    input,
    index,
    readRecordings,
    settled,
  };
}

test("missing observation is unavailable before any SD index or download request", async () => {
  const run = await fixture(async () => undefined);
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
  const run = await fixture(async () => {
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
  const run = await fixture(() => Promise.resolve(run.window));
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
  const run = await fixture((_id, signal) => {
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
  const run = await fixture(() => {
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

async function recordingDownload() {
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
  return { directory, peer, downloads, bytes };
}

test("a valid archived observation reaches SD playback and produces readable media", async () => {
  const { directory, peer, downloads } = await recordingDownload();
  let resolvedSignal: AbortSignal | undefined;
  const run = await fixture((id, signal) => {
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

test("clip playback reads shared original bytes with independent concurrent Range lifetimes", async () => {
  const { directory, peer, downloads, bytes } = await recordingDownload();
  const run = await fixture(() => {
    throw new Error("Clip playback does not resolve observation windows");
  }, peer.url.toString());
  const input = {
    ...run.input,
    selection: { kind: "clip" as const, startAt: run.window.startedAt },
  };
  run.index.recordings[0]!.endAt += 200;
  const second = { ...input, id: crypto.randomUUID() };
  try {
    run.service.request(input);
    run.service.request(second);
    await eventually(
      () =>
        run.service.state(input.id).state !== "preparing" &&
        run.service.state(second.id).state !== "preparing",
      5000,
    );
    expect(run.service.state(input.id)).toMatchObject({
      state: "ready",
      actualDurationMs: 1000,
      segments: [
        {
          startAt: input.selection.startAt,
          endAt: run.window.endedAt + 200,
          mediaStartMs: 0,
          mediaEndMs: 1000,
        },
      ],
      alignment: { type: "unknown", reason: "clip_selected" },
    });
    expect(downloads).toHaveBeenCalledTimes(1);
    expect(run.service.mediaInfo(input.id).bytes).toBe(bytes.byteLength);

    const intervals = [
      { start: 0, end: 31 },
      { start: 32, end: bytes.byteLength - 1 },
    ];
    const results = await Promise.all(
      intervals.map(async (range, index) => {
        const stream = run.service.read(
          index === 0 ? input.id : second.id,
          range,
          new AbortController().signal,
        );
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }),
    );
    for (const [index, result] of results.entries()) {
      const range = intervals[index]!;
      expect(result).toEqual(
        new Uint8Array(bytes.slice(range.start, range.end + 1)),
      );
    }

    const interrupted = new Response(
      run.service.read(
        input.id,
        { start: 0, end: bytes.byteLength - 1 },
        new AbortController().signal,
      ),
    )
      .arrayBuffer()
      .then(
        () => "completed",
        () => "cancelled",
      );
    await run.service.release(input.id);
    expect(await interrupted).toBe("cancelled");
    expect(() => run.service.mediaInfo(input.id)).toThrow();
    const retained = run.service.read(
      second.id,
      { start: 0, end: bytes.byteLength - 1 },
      new AbortController().signal,
    );
    expect(new Uint8Array(await new Response(retained).arrayBuffer())).toEqual(
      new Uint8Array(bytes),
    );
    expect(downloads).toHaveBeenCalledTimes(1);

    const revoked = new Response(
      run.service.read(
        second.id,
        { start: 0, end: bytes.byteLength - 1 },
        new AbortController().signal,
      ),
    )
      .arrayBuffer()
      .then(
        () => "completed",
        () => "cancelled",
      );
    run.source.abort();
    expect(await revoked).toBe("cancelled");
    expect(() => run.service.mediaInfo(second.id)).toThrow();
  } finally {
    await run.service.close();
    await peer.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("closing the original owner revokes ready clip playback and its active Range before playback closes", async () => {
  const { directory, peer, bytes } = await recordingDownload();
  const run = await fixture(() => undefined, peer.url.toString());
  const input = {
    ...run.input,
    selection: { kind: "clip" as const, startAt: run.window.startedAt },
  };
  try {
    run.service.request(input);
    expect(await run.settled()).toMatchObject({ state: "ready" });
    const pending = new Response(
      run.service.read(
        input.id,
        { start: 0, end: bytes.byteLength - 1 },
        new AbortController().signal,
      ),
    )
      .arrayBuffer()
      .then(
        () => "completed",
        () => "cancelled",
      );

    await run.originals.close();
    expect(await pending).toBe("cancelled");
    expect(run.service.state(input.id)).toMatchObject({ state: "revoked" });
    expect(() => run.service.mediaInfo(input.id)).toThrow();
  } finally {
    await run.service.close();
    await peer.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
