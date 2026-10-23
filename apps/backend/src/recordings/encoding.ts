import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Demuxer } from "node-av/api";
import {
  AV_CODEC_ID_MJPEG,
  AV_NOPTS_VALUE,
  AV_PKT_FLAG_CORRUPT,
  AVERROR_EOF,
} from "node-av/constants";
import { FFmpegError, Packet } from "node-av/lib";
import { RecordingCoverageError } from "./selection";
import { join } from "node:path";
import { inspectMedia } from "../media/inspection";
import type { transformMedia } from "./transform";
import type { decodedFrames, prepareTimeline } from "./timeline";
import { createFfmpegProcess } from "../media/ffmpeg";

export async function encodeMedia(
  options: Parameters<typeof transformMedia>[0],
  timeline: Awaited<ReturnType<typeof prepareTimeline>>,
  selected: Awaited<ReturnType<typeof decodedFrames>>,
  spatial: string[],
) {
  const {
    signal,
    input: { output },
  } = options;
  const {
    requestedStart,
    requestedEnd,
    seekStart,
    ffmpegInput,
    origin,
    media,
  } = timeline;
  const command = [
    "-ss",
    String(seekStart),
    "-noaccurate_seek",
    ...ffmpegInput,
    "-map",
    "0:v:0",
  ];
  if (output.kind !== "video") {
    const files: {
      path: string;
      bytes: number;
      contentType: string;
      width: number;
      height: number;
      at: number;
    }[] = [];
    let select = `lt(abs(t-${selected[0]!.offsetMs / 1000}),0.000001)`;
    if (output.kind === "images") {
      let previous = -1;
      const interval = 1000 / output.fps;
      selected = selected.filter((frame) => {
        const slot = Math.floor(
          (frame.offsetMs - requestedStart + 0.001) / interval,
        );
        if (slot <= previous) return false;
        previous = slot;
        return true;
      });
      // Select the first actual frame in each sampling interval without duplicating frames.
      const slot = `(t*1000-${requestedStart}+0.001)/${interval}`;
      const previousSlot = `(prev_selected_t*1000-${requestedStart}+0.001)/${interval}`;
      select = `gte(t,${selected[0]!.offsetMs / 1000 - 0.000001})*lt(t,${requestedEnd / 1000})*if(isnan(prev_selected_t),1,gt(floor(${slot}),floor(${previousSlot})))`;
    }
    const basename = `image-${crypto.randomUUID()}`;
    await createFfmpegProcess(
      options.executable,
      [
        ...command,
        "-an",
        "-sn",
        "-dn",
        "-vf",
        [`select='${select}'`, ...spatial].join(","),
        "-frames:v",
        String(selected.length),
        "-fps_mode",
        "passthrough",
        "-filter_threads",
        "1",
        "-c:v",
        "mjpeg",
        "-pix_fmt",
        "yuvj444p",
        "-q:v",
        "2",
        "-enc_time_base:v",
        "1:90000",
        "-avoid_negative_ts",
        "disabled",
        "-f",
        "nut",
        "-write_index",
        "0",
        "pipe:1",
      ],
      signal,
      async (stdout, outputSignal) => {
        await using encoded = await Demuxer.open(stdout, {
          format: "nut",
          copyTs: true,
          skipStreamInfo: true,
          signal: outputSignal,
        });
        const video = encoded.video();
        if (
          !video ||
          video.codecpar.codecId !== AV_CODEC_ID_MJPEG ||
          video.codecpar.width <= 0 ||
          video.codecpar.height <= 0
        )
          throw new RecordingCoverageError("Generated images are unavailable");
        using packet = new Packet();
        packet.alloc();
        const context = encoded.getFormatContext();
        let index = 0;
        while (true) {
          outputSignal.throwIfAborted();
          const status = await context.readFrame(packet);
          outputSignal.throwIfAborted();
          if (status === AVERROR_EOF) break;
          FFmpegError.throwIfError(status, "Generated image could not be read");
          try {
            if (packet.streamIndex !== video.index) continue;
            const frame = selected[index];
            const path = join(
              options.directory,
              `${basename}-${index + 1}.jpg`,
            );
            const data = packet.data;
            const at =
              (Number(packet.pts) * 1000 * video.timeBase.num) /
              video.timeBase.den;
            if (
              !frame ||
              !data?.byteLength ||
              packet.pts === AV_NOPTS_VALUE ||
              (packet.flags & AV_PKT_FLAG_CORRUPT) !== 0 ||
              Math.abs(at - frame.offsetMs) > 1 / 90 + 0.000001
            )
              throw new RecordingCoverageError(
                "Generated images do not match the selected frames",
              );
            await pipeline(
              Readable.from([data]),
              await options.openOutput(path),
              { signal: outputSignal },
            );
            files.push({
              path,
              bytes: data.byteLength,
              contentType: "image/jpeg",
              width: video.codecpar.width,
              height: video.codecpar.height,
              at: origin + frame.offsetMs,
            });
            index++;
          } finally {
            packet.unref();
          }
        }
        if (index !== selected.length)
          throw new RecordingCoverageError("Generated images are incomplete");
      },
    ).completed;
    return { kind: output.kind, files };
  }
  const last = selected[selected.length - 1]!;
  const codec = output.codec ?? media[0]!.codec;
  const path = join(options.directory, `video-${crypto.randomUUID()}.mp4`);
  const trimStart = selected[0]!.offsetMs / 1000;
  const trimEnd = (last.offsetMs + last.durationMs) / 1000;
  const filters = [
    `trim=start=${trimStart}:end=${trimEnd}`,
    `setpts=PTS-${trimStart}/TB`,
    ...spatial,
    ...(output.fps
      ? [`fps=fps=${output.fps}:start_time=0:eof_action=pass`]
      : []),
  ];
  const hasAudio = media.some((item) => item.hasAudio);
  const pixelFormat =
    (output.width && output.width % 2 !== 0) ||
    (output.height && output.height % 2 !== 0)
      ? "yuv444p"
      : "yuv420p";
  await createFfmpegProcess(
    options.executable,
    [
      ...command,
      "-map",
      "0:a:0?",
      "-sn",
      "-dn",
      "-vf",
      filters.join(","),
      "-filter_threads",
      "1",
      "-fps_mode",
      "passthrough",
      "-enc_time_base:v",
      "1:90000",
      "-c:v",
      codec === "h264" ? "libx264" : "libx265",
      "-preset",
      "ultrafast",
      "-crf",
      "23",
      "-pix_fmt",
      pixelFormat,
      "-threads:v",
      "1",
      ...(codec === "h265"
        ? [
            "-x265-params",
            "pools=none:frame-threads=1:bframes=0",
            "-tag:v",
            "hvc1",
          ]
        : []),
      ...(hasAudio
        ? [
            "-af",
            `atrim=start=${trimStart}:end=${trimEnd},asetpts=PTS-${trimStart}/TB`,
            "-c:a",
            "aac",
            "-threads:a",
            "1",
          ]
        : ["-an"]),
      "-bsf:v",
      `setts=pts=PTS:dts=DTS:duration='min(DURATION,${trimEnd - trimStart}/TB-PTS)'`,
      "-avoid_negative_ts",
      "disabled",
      "-movflags",
      "frag_keyframe+empty_moov+delay_moov+default_base_moof",
      "-video_track_timescale",
      "90000",
      "-f",
      "mp4",
      "pipe:1",
    ],
    signal,
    async (stdout, outputSignal) => {
      await pipeline(stdout, await options.openOutput(path), {
        signal: outputSignal,
      });
    },
  ).completed;
  const encoded = await inspectMedia(path, signal);
  const files = [
    {
      path,
      bytes: encoded.bytes,
      contentType: "video/mp4",
      width: encoded.width,
      height: encoded.height,
    },
  ];
  return { kind: output.kind, files, codec, hasAudio: encoded.hasAudio };
}
