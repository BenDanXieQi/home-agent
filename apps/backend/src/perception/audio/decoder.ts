import { createFfmpegProcess } from "../../media/ffmpeg";
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
  let process: ReturnType<typeof createFfmpegProcess<void>> | undefined;
  let packetTimer: ReturnType<typeof setTimeout> | undefined;
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
      const anchorMonotonic =
        performance.now() - (Date.now() - anchorReceivedAt);
      options.onMedia({ generation, anchorReceivedAt, decodedStartOffsetMs });
      controller.signal.throwIfAborted();
      process = createFfmpegProcess(
        options.executable,
        [
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
        controller.signal,
        async (stdout, signal) => {
          await using demuxer = await Demuxer.open(stdout, {
            format: "nut",
            copyTs: true,
            options: { probesize: 32, analyzeduration: 1 },
            signal,
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
              signal.throwIfAborted();
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
          throw new Error("Audio decoder ended");
        },
        { liveInput: stream },
      );
      await process.completed;
    } finally {
      clearTimeout(packetTimer);
      controller.abort();
    }
  })();
  return {
    completed,
    async close() {
      controller.abort(new Error("Audio source stopped"));
      await Promise.allSettled([completed]);
      await process?.close();
    },
  };
}
