import { join } from "node:path";
import { Readable, type Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { BitStreamFilterAPI, Demuxer, Muxer } from "node-av/api";
import { AV_NOPTS_VALUE, AV_PKT_DATA_NEW_EXTRADATA } from "node-av/constants";
import type { z } from "zod";
import { inspectMedia } from "../media/inspection";
import { readAnalysisStream } from "../mijia/media/analysis-stream";
import type { sourceAccessSchema } from "../perception/sources";

function capturedSegment(
  path: string,
  media: Awaited<ReturnType<typeof inspectMedia>>,
  source: Awaited<ReturnType<typeof readAnalysisStream>>,
  observedAt: number,
  runId: string,
  sequence: number,
) {
  const originMs = 1000 / source.media.clockRate;
  return {
    path,
    media,
    runId,
    sequence,
    startedAt: observedAt + media.startPtsMs - originMs,
    endedAt: observedAt + media.endPtsMs - originMs,
  };
}

export async function captureRecording(options: {
  directory: string;
  access: z.infer<typeof sourceAccessSchema>;
  signal: AbortSignal;
  openOutput: (path: string) => Writable;
  closed: (segment: ReturnType<typeof capturedSegment>) => Promise<void>;
}) {
  const stop = new AbortController();
  const signal = AbortSignal.any([options.signal, stop.signal]);
  const source = await readAnalysisStream(options.access, signal);
  const observedAt = Date.now();
  const readable = Readable.fromWeb(source.stream);
  const runId = crypto.randomUUID();
  const prefix = `segment-${runId}-`;
  try {
    await using input = await Demuxer.open(readable, {
      format: "mpegts",
      copyTs: true,
      signal,
      options: { analyzeduration: 0, probesize: 32_768 },
    });
    const stream = input.video();
    if (!stream) throw new Error("Recording has no video stream");
    const video = stream;
    using extract = BitStreamFilterAPI.create("extract_extradata", video, {
      signal,
    });
    using repeat = BitStreamFilterAPI.create("dump_extra", video, {
      signal,
      options: { freq: "keyframe" },
    });
    let parameters: string | undefined;
    let nextSequence = 0;
    let current: Awaited<ReturnType<typeof openSegment>> | undefined;

    async function openSegment(startPtsMs: number) {
      signal.throwIfAborted();
      const sequence = nextSequence++;
      const path = join(
        options.directory,
        `${prefix}${String(sequence).padStart(6, "0")}.ts`,
      );
      const writer = options.openOutput(path);
      let failure: unknown;
      const completed = finished(writer).catch((cause: unknown) => {
        failure ??= cause;
      });
      let output: Awaited<ReturnType<typeof Muxer.open>> | undefined;
      try {
        output = await Muxer.open(
          {
            write: async (chunk) => {
              try {
                signal.throwIfAborted();
                await new Promise<void>((resolve, reject) => {
                  writer.write(chunk, (cause) => {
                    if (cause) reject(cause);
                    else resolve();
                  });
                });
                return chunk.length;
              } catch (cause) {
                failure ??= cause;
                throw cause;
              }
            },
          },
          {
            format: "mpegts",
            signal,
            useSyncQueue: false,
            options: { mpegts_copyts: true },
          },
        );
        const index = output.addStream(video);
        return {
          output,
          index,
          writer,
          completed,
          path,
          sequence,
          startPtsMs,
          check() {
            if (failure) throw failure;
          },
        };
      } catch (cause) {
        await output?.close();
        writer.destroy();
        await completed;
        throw cause;
      }
    }

    async function closeSegment(publish: boolean) {
      const segment = current;
      current = undefined;
      if (!segment) return;
      try {
        await segment.output.close();
        segment.writer.end();
        await segment.completed;
        segment.check();
        if (publish) {
          signal.throwIfAborted();
          const media = await inspectMedia(segment.path, signal);
          await options.closed(
            capturedSegment(
              segment.path,
              media,
              source,
              observedAt,
              runId,
              segment.sequence,
            ),
          );
        }
      } finally {
        segment.writer.destroy();
        await segment.completed;
      }
    }

    try {
      for await (const packet of extract.packets(input.packets(video.index))) {
        if (!packet) break;
        try {
          signal.throwIfAborted();
          const extra = packet.getSideData(AV_PKT_DATA_NEW_EXTRADATA);
          if (extra) {
            const fingerprint = extra.toString("hex").replace(/(?:00)+$/, "");
            if (parameters && parameters !== fingerprint)
              throw new Error("Recording codec parameters changed");
            parameters = fingerprint;
            video.codecpar.extradata = extra;
          }

          const timestamp =
            packet.pts === AV_NOPTS_VALUE ? packet.dts : packet.pts;
          if (timestamp === AV_NOPTS_VALUE)
            throw new Error("Recording video timestamps are unavailable");
          const ptsMs =
            (Number(timestamp) * 1000 * video.timeBase.num) /
            video.timeBase.den;
          if (packet.isKeyframe) {
            if (current && ptsMs - current.startPtsMs >= 10_000)
              await closeSegment(true);
            current ??= await openSegment(ptsMs);
          }
          if (!current) continue;

          for (const filtered of await repeat.filterAll(packet)) {
            try {
              await current.output.writePacket(filtered, current.index);
              current.check();
            } finally {
              filtered.free();
            }
          }
        } finally {
          packet.free();
        }
      }
      await closeSegment(true);
      signal.throwIfAborted();
    } finally {
      await closeSegment(false);
    }
  } finally {
    stop.abort();
    readable.destroy();
  }
}
