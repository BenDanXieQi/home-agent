import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import pTimeout from "p-timeout";
import { Demuxer } from "node-av/api";
import { AV_CODEC_ID_PCM_S16LE } from "node-av/constants";
import type { z } from "zod";
import type { perceptionConfigSchema } from "../config";
import type { encodedAudioSchema } from "./encoded-stream";
import type { pcmSchema } from "./pcm";

export function createAudioDecoder(options: {
  config: Pick<
    z.infer<typeof perceptionConfigSchema>,
    "firstFrameTimeoutMs" | "silenceTimeoutMs" | "maxFrameAgeMs"
  >;
  executable: string;
  open: (
    signal: AbortSignal,
  ) => Promise<
    z.infer<typeof encodedAudioSchema> & { stream: ReadableStream<Uint8Array> }
  >;
  onMedia: (
    media: Pick<
      z.infer<typeof encodedAudioSchema>,
      "generation" | "anchorReceivedAt" | "decodedStartOffsetMs"
    >,
  ) => void;
  onPcm: (
    samples: z.infer<typeof pcmSchema>,
    observedAt: number,
    receivedAt: number,
  ) => Promise<void>;
}) {
  const controller = new AbortController();
  let child: ReturnType<typeof spawn> | undefined;
  let exit: Promise<unknown> = Promise.resolve();
  let io: Promise<unknown>[] = [];
  let packetTimer: ReturnType<typeof setTimeout> | undefined;
  let diagnostic = "";
  function arm(ms: number) {
    clearTimeout(packetTimer);
    packetTimer = setTimeout(
      () => controller.abort(new Error("Audio packet deadline exceeded")),
      ms,
    );
  }
  const completed = (async () => {
    arm(options.config.firstFrameTimeoutMs);
    try {
      const {
        stream,
        format,
        generation,
        anchorReceivedAt,
        decodedStartOffsetMs,
      } = await options.open(controller.signal);
      // Use the source anchor and sample position, never the time a buffered packet is dequeued.
      const anchorMonotonic =
        performance.now() - (Date.now() - anchorReceivedAt);
      options.onMedia({ generation, anchorReceivedAt, decodedStartOffsetMs });
      controller.signal.throwIfAborted();
      child = spawn(
        options.executable,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-threads",
          "1",
          "-max_alloc",
          "33554432",
          "-probesize",
          "32768",
          "-analyzeduration",
          "100000",
          "-f",
          format,
          ...(format === "alaw" ? ["-ar", "8000", "-ac", "1"] : []),
          "-i",
          "pipe:0",
          "-map",
          "0:a:0",
          "-vn",
          "-sn",
          "-dn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-threads",
          "1",
          "-filter_threads",
          "1",
          "-af",
          "aformat=sample_fmts=s16:sample_rates=16000:channel_layouts=mono,asetnsamples=n=512:p=0",
          "-c:a",
          "pcm_s16le",
          "-enc_time_base",
          "1:16000",
          "-f",
          "nut",
          "-write_index",
          "0",
          "-flush_packets",
          "1",
          "pipe:1",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      exit = new Promise<void>((resolve, reject) => {
        child!.once("error", (error) => {
          diagnostic = error.message;
          if (child?.pid === undefined) resolve();
          else reject(error);
        });
        child!.once("exit", () => resolve());
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        diagnostic = (diagnostic + chunk.toString()).slice(-2048);
      });
      const input = pipeline(Readable.fromWeb(stream), child.stdin!, {
        signal: controller.signal,
      });
      const output = (async () => {
        await using demuxer = await Demuxer.open(child.stdout!, {
          format: "nut",
          copyTs: true,
          options: { probesize: 32, analyzeduration: 1 },
          signal: controller.signal,
        });
        const audio = demuxer.audio();
        if (
          !audio ||
          audio.codecpar.codecId !== AV_CODEC_ID_PCM_S16LE ||
          audio.codecpar.sampleRate !== 16000 ||
          audio.codecpar.channels !== 1 ||
          audio.timeBase.num !== 1 ||
          audio.timeBase.den !== 16000
        )
          throw new Error("Invalid decoded PCM contract");
        let end: number | undefined;
        let firstPts: number | undefined;
        for await (const packet of demuxer.packets(audio.index)) {
          if (!packet) break;
          try {
            controller.signal.throwIfAborted();
            const pts = Number(packet.pts);
            if (
              !packet.data ||
              packet.size <= 0 ||
              packet.size > 4096 ||
              packet.size % 2 ||
              !Number.isSafeInteger(pts) ||
              (end !== undefined && pts !== end)
            )
              throw new Error("Audio PCM gap or invalid packet size");
            const data = Buffer.from(packet.data);
            const pcm = new Int16Array(data.length / 2);
            for (let i = 0; i < pcm.length; i++)
              pcm[i] = data.readInt16LE(i * 2);
            firstPts ??= pts;
            const offsetMs = decodedStartOffsetMs + (pts - firstPts) / 16;
            const ageMs = performance.now() - anchorMonotonic - offsetMs;
            if (ageMs > options.config.maxFrameAgeMs)
              throw new Error("Audio media exceeded maximum age");
            if (ageMs < -options.config.maxFrameAgeMs)
              throw new Error(
                "Audio media clock advanced beyond its receive anchor",
              );
            end = pts + pcm.length;
            arm(options.config.silenceTimeoutMs);
            await options.onPcm(pcm, anchorReceivedAt + offsetMs, Date.now());
          } finally {
            packet.free();
          }
        }
        throw new Error(`Audio decoder ended: ${diagnostic}`);
      })();
      io = [input, output];
      await Promise.race([
        output,
        input.then(() => {
          throw new Error("Audio stream ended");
        }),
        exit.then(() => {
          throw new Error(`Audio FFmpeg exited: ${diagnostic}`);
        }),
      ]);
    } finally {
      clearTimeout(packetTimer);
      controller.abort();
      child?.kill("SIGKILL");
      await pTimeout(Promise.allSettled([exit, ...io]), {
        milliseconds: 3000,
        message: "Audio decoder cleanup unconfirmed",
      });
    }
  })();
  return {
    completed,
    async close() {
      controller.abort(new Error("Audio source stopped"));
      child?.kill("SIGKILL");
      await Promise.allSettled([completed]);
      await pTimeout(Promise.allSettled([exit, ...io]), {
        milliseconds: 3000,
        message: "Audio decoder exit unconfirmed",
      });
    },
  };
}
