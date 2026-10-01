import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import {
  sourceAccessSchema,
  type PerceptionSources,
} from "../../src/perception/sources";

// A paced encoded source exercises the production HTTP/FFmpeg/IPC path.
// Quiet and audible sources are distinct physical inputs, not mocked VAD results.
export async function createAudioSource(
  count = 1,
  options: { speech?: Uint8Array; video?: boolean } = {},
) {
  if (
    options.speech &&
    (!options.speech.length || options.speech.length > 480000)
  )
    throw new Error(
      "Speech fixture must contain at most 60 seconds of raw 8 kHz A-law",
    );
  const videoEncoders = new Set<ReturnType<typeof spawn>>();
  const videoExits = new Set<Promise<void>>();
  let videoRequests = 0;
  const encoder = spawn(
    process.env.PERCEPTION_FFMPEG_PATH ?? "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=400:sample_rate=8000:duration=1",
      "-c:a",
      "pcm_alaw",
      "-f",
      "alaw",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const encoderExit = new Promise<number | null>((resolve, reject) => {
    encoder.once("error", reject);
    encoder.once("close", resolve);
  });
  const [encoded, exitCode, diagnostic] = await Promise.all([
    new Response(Readable.toWeb(encoder.stdout)).arrayBuffer(),
    encoderExit,
    new Response(Readable.toWeb(encoder.stderr)).text(),
  ]);
  if (exitCode !== 0)
    throw new Error(`Unable to encode the audio fixture: ${diagnostic}`);
  const tone = new Uint8Array(encoded);
  const quiet = new Uint8Array(tone.length).fill(0xd5);
  let scopeEpoch = crypto.randomUUID();
  let allowed = true;
  let lease = new AbortController();
  const selected = Array.from({ length: count }, (_, index) => ({
    deviceId: String(1000 + index),
    channel: 1 as const,
  }));
  const sourceIds = selected.map(() => crypto.randomUUID());
  const sessionId = crypto.randomUUID();
  const modes = new Map(
    selected.map(({ deviceId }) => [
      deviceId,
      options.speech ? "speech" : "tone",
    ]),
  );
  const readers = new Set<AbortController>();
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const input = sourceAccessSchema
        .omit({ endpoint: true })
        .parse(await request.json());
      const source =
        selected[sourceIds.findIndex((id) => id === input.sourceId)];
      if (!source) return new Response(null, { status: 404 });
      if (options.video && new URL(request.url).pathname === "/analysis") {
        videoRequests++;
        const child = spawn(
          process.env.PERCEPTION_FFMPEG_PATH ?? "ffmpeg",
          [
            "-v",
            "error",
            "-re",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1280x720:rate=15",
            "-threads",
            "1",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-g",
            "15",
            "-bf",
            "0",
            "-f",
            "mpegts",
            "-muxdelay",
            "0",
            "pipe:1",
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        videoEncoders.add(child);
        const exit = new Promise<void>((resolveExit) => {
          child.once("exit", () => {
            videoEncoders.delete(child);
            videoExits.delete(exit);
            resolveExit();
          });
          child.once("error", (error) => {
            console.error("Video fixture encoder failed", error);
            videoEncoders.delete(child);
            videoExits.delete(exit);
            resolveExit();
          });
        });
        videoExits.add(exit);
        request.signal.addEventListener(
          "abort",
          () => {
            child.kill("SIGKILL");
          },
          { once: true },
        );
        child.stderr?.on("data", (data: Buffer) => {
          console.error(data.toString());
        });
        return new Response(Readable.toWeb(child.stdout), {
          headers: {
            "Content-Type": "video/mp2t",
            "X-Media-Generation": crypto.randomUUID(),
            "X-Media-Clock-Rate": "90000",
            "X-Media-Pts-Origin": "0",
          },
        });
      }
      requests++;
      if (modes.get(source.deviceId) === "missing")
        return Response.json({ code: "audio_track_missing" }, { status: 422 });
      const stopped = new AbortController();
      readers.add(stopped);
      const signal = AbortSignal.any([stopped.signal, request.signal]);
      signal.addEventListener(
        "abort",
        () => {
          readers.delete(stopped);
        },
        { once: true },
      );
      let samples = 0;
      const started = performance.now();
      const anchor =
        Date.now() - (modes.get(source.deviceId) === "old" ? 5000 : 0);
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (modes.get(source.deviceId) === "stalled") {
              await delay(60_000, undefined, { signal });
              return;
            }
            await delay(
              Math.max(0, started + samples / 8 - performance.now()),
              undefined,
              { signal },
            );
            const mode = modes.get(source.deviceId);
            const bytes =
              mode === "quiet"
                ? quiet
                : mode === "speech"
                  ? options.speech
                  : tone;
            if (!bytes) throw new Error("Speech source has no fixture");
            const offset = samples % bytes.length;
            const chunk = bytes.subarray(
              offset,
              Math.min(offset + 160, bytes.length),
            );
            samples += chunk.length;
            controller.enqueue(chunk);
          } catch (error) {
            controller.error(error);
          }
        },
        cancel() {
          stopped.abort();
          readers.delete(stopped);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Audio-Format": "alaw",
          "X-Audio-Generation": crypto.randomUUID(),
          "X-Audio-Received-At": String(anchor),
          "X-Audio-Start-Offset-Ms": "0",
        },
      });
    },
  });
  const sources = {
    list: () => (allowed ? selected : []),
    eligibility: () =>
      allowed
        ? {
            scopeEpoch,
            identity: scopeEpoch,
            householdVersion: { scope_epoch: scopeEpoch, sequence: 0 },
          }
        : null,
    subscribe: () => () => {},
    async prepare(source, signal) {
      signal.throwIfAborted();
      return {
        access: {
          endpoint: `${server.url.toString()}analysis`,
          sessionId,
          sourceId:
            sourceIds[
              selected.findIndex((entry) => entry.deviceId === source.deviceId)
            ]!,
        },
        signal: lease.signal,
      };
    },
  } satisfies PerceptionSources;
  return {
    selected,
    sources,
    modes,
    get activeReaders() {
      return readers.size;
    },
    get requests() {
      return requests;
    },
    get videoRequests() {
      return videoRequests;
    },
    revoke() {
      allowed = false;
      lease.abort();
    },
    grant() {
      scopeEpoch = crypto.randomUUID();
      lease = new AbortController();
      allowed = true;
    },
    async close() {
      lease.abort();
      for (const reader of readers) reader.abort();
      for (const child of videoEncoders) child.kill("SIGKILL");
      await server.stop(true);
      await Promise.all(videoExits);
    },
  };
}
