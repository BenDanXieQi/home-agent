import { createFfmpegProcess } from "../../media/ffmpeg";
import { readNutFrames } from "./nut-frames";
import type { sourceMediaSchema } from "@home-agent/api/contracts";
import type { z } from "zod";
import type { VideoFrame } from "./latest-frame";

export function createFfmpegDecoder(options: {
  executable: string;
  read: (signal: AbortSignal) => Promise<{
    stream: ReadableStream<Uint8Array>;
    media: z.infer<typeof sourceMediaSchema>;
    ptsOrigin: number;
  }>;
  sampleFps: number;
  firstFrameTimeoutMs: number;
  silenceTimeoutMs: number;
  onMedia: (media: z.infer<typeof sourceMediaSchema>) => void;
  onFrame: (
    frame: Omit<VideoFrame, "sequence" | "receivedAt" | "availableAt">,
  ) => void;
}) {
  const controller = new AbortController();
  let process: ReturnType<typeof createFfmpegProcess<void>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  function arm(milliseconds: number) {
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        controller.abort(new Error("Video complete-frame deadline exceeded")),
      milliseconds,
    );
  }
  const completed = (async () => {
    arm(options.firstFrameTimeoutMs);
    try {
      const { stream, media, ptsOrigin } = await options.read(
        controller.signal,
      );
      controller.signal.throwIfAborted();
      options.onMedia(media);
      process = createFfmpegProcess(
        options.executable,
        [
          "-max_alloc",
          "33554432",
          "-max_pixels",
          "8294400",
          "-probesize",
          "1048576",
          "-analyzeduration",
          "1000000",
          "-copyts",
          "-correct_ts_overflow",
          "0",
          "-f",
          "mpegts",
          "-i",
          "pipe:0",
          "-map",
          "0:v:0",
          "-an",
          "-sn",
          "-dn",
          "-threads",
          "1",
          "-filter_threads",
          "1",
          "-vf",
          `select='isnan(prev_selected_t)+lt(t,prev_selected_t)+gte(t-prev_selected_t,${1 / options.sampleFps})'`,
          "-fps_mode",
          "passthrough",
          "-c:v",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "-f",
          "nut",
          "-enc_time_base",
          "1:90000",
          "-avoid_negative_ts",
          "disabled",
          "-write_index",
          "0",
          "-flush_packets",
          "1",
          "pipe:1",
        ],
        controller.signal,
        async (stdout, signal) => {
          for await (const frame of readNutFrames(stdout, signal)) {
            signal.throwIfAborted();
            const sourcePts = frame.pts + ptsOrigin;
            if (sourcePts > 0xffffffff)
              throw new Error(
                "Analysis frame crossed its source media generation",
              );
            arm(options.silenceTimeoutMs);
            options.onFrame({
              width: frame.width,
              height: frame.height,
              rgb: frame.rgb,
              mediaTime: {
                generation: media.generation,
                pts: sourcePts,
                rtpTimestamp: sourcePts,
                timeBaseNumerator: 1,
                timeBaseDenominator: 90000,
                quality: "source_media",
              },
            });
          }
          throw new Error("Video decoder ended");
        },
        { liveInput: stream },
      );
      await process.completed;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  })();
  return {
    completed,
    close() {
      closing ??= (async () => {
        controller.abort(new Error("Video source stopped"));
        await Promise.allSettled([completed]);
        await process?.close();
      })();
      return closing;
    },
  };
}
