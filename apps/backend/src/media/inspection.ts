import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { Demuxer } from "node-av/api";
import {
  AV_CODEC_ID_H264,
  AV_CODEC_ID_HEVC,
  AV_NOPTS_VALUE,
} from "node-av/constants";

export function describeMedia(input: Demuxer) {
  const video = input.video();
  if (!video) throw new Error("Recording has no video stream");
  const parameters = video.codecpar;
  const codec =
    parameters.codecId === AV_CODEC_ID_H264
      ? ("h264" as const)
      : parameters.codecId === AV_CODEC_ID_HEVC
        ? ("h265" as const)
        : null;
  if (!codec) throw new Error("Recording video codec is unsupported");
  const { width, height } = parameters;
  const codecFingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        input.streams.map((stream) => {
          const streamParameters = stream.codecpar;
          return {
            index: stream.index,
            codecType: streamParameters.codecType,
            codecId: streamParameters.codecId,
            width: streamParameters.width,
            height: streamParameters.height,
            format: streamParameters.format,
            profile: streamParameters.profile,
            level: streamParameters.level,
            colorRange: streamParameters.colorRange,
            colorSpace: streamParameters.colorSpace,
            colorPrimaries: streamParameters.colorPrimaries,
            colorTrc: streamParameters.colorTrc,
            sampleRate: streamParameters.sampleRate,
            channels: streamParameters.channelLayout.nbChannels,
            timeBase: { num: stream.timeBase.num, den: stream.timeBase.den },
            sampleAspectRatio: {
              num: streamParameters.sampleAspectRatio.num,
              den: streamParameters.sampleAspectRatio.den,
            },
            extradata:
              streamParameters.extradata
                ?.toString("hex")
                .replace(/(?:00)+$/, "") ?? "",
          };
        }),
      ),
    )
    .digest("hex");
  return {
    codec,
    width,
    height,
    hasAudio: input.audio() !== undefined,
    codecFingerprint,
    format: input.getFormatContext().iformat?.name ?? "unknown",
  };
}

export async function inspectMedia(path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  await using input = await Demuxer.open(path, {
    copyTs: true,
    signal,
    options: { protocol_whitelist: "file" },
  });
  const video = input.video();
  if (!video) throw new Error("Recording has no video stream");
  const description = describeMedia(input);
  const timeBase = video.timeBase;
  const scale = (1000 * timeBase.num) / timeBase.den;
  let startPtsMs = Infinity;
  let endPtsMs = -Infinity;
  let lastPtsMs = -Infinity;
  let lastDurationMs = 0;
  for await (const packet of input.packets(video.index)) {
    if (!packet) break;
    try {
      signal.throwIfAborted();
      if (packet.pts === AV_NOPTS_VALUE) continue;
      const ptsMs = Number(packet.pts) * scale;
      const durationMs = Number(packet.duration) * scale;
      startPtsMs = Math.min(startPtsMs, ptsMs);
      endPtsMs = Math.max(endPtsMs, ptsMs + durationMs);
      if (ptsMs > lastPtsMs) {
        lastDurationMs = durationMs || ptsMs - lastPtsMs;
        lastPtsMs = ptsMs;
      }
    } finally {
      packet.free();
    }
  }
  if (!Number.isFinite(startPtsMs) || !Number.isFinite(endPtsMs))
    throw new Error("Recording video timestamps are unavailable");
  if (endPtsMs <= lastPtsMs && Number.isFinite(lastDurationMs))
    endPtsMs = lastPtsMs + lastDurationMs;
  const info = await stat(path);
  return {
    ...description,
    bytes: info.size,
    startPtsMs,
    endPtsMs,
    formatStartPtsMs:
      input.getFormatContext().startTime === AV_NOPTS_VALUE
        ? startPtsMs
        : Number(input.getFormatContext().startTime) / 1000,
  };
}
