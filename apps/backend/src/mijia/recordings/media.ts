import { createHash } from "node:crypto";
import { lstat, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Demuxer } from "node-av/api";
import { Packet } from "node-av/lib";
import {
  AVERROR_EOF,
  AVMEDIA_TYPE_AUDIO,
  AVMEDIA_TYPE_VIDEO,
  AV_NOPTS_VALUE,
  AV_PKT_FLAG_CORRUPT,
} from "node-av/constants";
import { frameLimits } from "@home-agent/api/contracts";
import { MediaCleanupError } from "../../media/resources";
import { runFfmpeg } from "../../media/ffmpeg";

const limits = {
  segmentMs: 255_000,
  totalMs: 720_000,
  files: 3,
  fileBytes: 96 * 1024 * 1024,
  packetBytes: 32 * 1024 * 1024,
  packets: 200_000,
  fingerprintBytes: 2 * 1024 * 1024,
};

function invalidMedia() {
  return new Error("recording_media_invalid");
}

function checkSignal(signal: AbortSignal) {
  if (signal.aborted) throw new Error("recording_media_cancelled");
}

async function recordingFile(file: string) {
  if (!isAbsolute(file) || resolve(file) !== file || !file.endsWith(".mp4"))
    throw invalidMedia();
  const info = await lstat(file);
  if (!info.isFile() || info.size === 0 || info.size >= limits.fileBytes)
    throw invalidMedia();
  return info.size;
}

function timestamp(value: bigint) {
  const result = Number(value);
  if (value === AV_NOPTS_VALUE || !Number.isSafeInteger(result))
    throw invalidMedia();
  return result;
}

export async function inspectRecording(
  file: string,
  signal: AbortSignal,
  maxDurationMs = limits.segmentMs,
) {
  try {
    checkSignal(signal);
    await recordingFile(file);
    if (
      !Number.isFinite(maxDurationMs) ||
      maxDurationMs <= 0 ||
      maxDurationMs > limits.totalMs
    )
      throw invalidMedia();
    await using input = await Demuxer.open(file, {
      format: "mov",
      copyTs: true,
      signal,
      options: {
        protocol_whitelist: "file",
        enable_drefs: false,
        use_absolute_path: false,
        probesize: 1_048_576,
        analyzeduration: 1_000_000,
        fpsprobesize: 0,
        err_detect: "explode",
      },
    });
    checkSignal(signal);
    const video = input.video();
    if (
      !video ||
      input.streams.length > 2 ||
      input.streams.filter(
        (stream) => stream.codecpar.codecType === AVMEDIA_TYPE_VIDEO,
      ).length !== 1 ||
      input.streams.some(
        (stream) =>
          stream.codecpar.codecType !== AVMEDIA_TYPE_VIDEO &&
          stream.codecpar.codecType !== AVMEDIA_TYPE_AUDIO,
      )
    )
      throw invalidMedia();
    const { width, height } = video.codecpar;
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width > frameLimits.maxDimension ||
      height > frameLimits.maxDimension ||
      width * height > frameLimits.maxPixels
    )
      throw invalidMedia();
    const streams = input.streams.map((stream) => {
      const codec = stream.codecpar;
      const { num, den } = stream.timeBase;
      const declaredPackets = timestamp(stream.nbFrames);
      if (
        !Number.isSafeInteger(num) ||
        !Number.isSafeInteger(den) ||
        num <= 0 ||
        den <= 0 ||
        declaredPackets < 0 ||
        declaredPackets > limits.packets
      )
        throw invalidMedia();
      const description = {
        index: stream.index,
        codecType: codec.codecType,
        codecId: codec.codecId,
        width: codec.width,
        height: codec.height,
        format: codec.format,
        sampleRate: codec.sampleRate,
        channels: codec.channelLayout.nbChannels,
        timeBaseNumerator: num,
        timeBaseDenominator: den,
      };
      const codecFingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            ...description,
            colorRange: codec.colorRange,
            colorSpace: codec.colorSpace,
            colorPrimaries: codec.colorPrimaries,
            colorTrc: codec.colorTrc,
            sampleAspectRatio: {
              num: codec.sampleAspectRatio.num,
              den: codec.sampleAspectRatio.den,
            },
          }),
        )
        .update(codec.extradata ?? Buffer.alloc(0))
        .digest("hex");
      return {
        ...description,
        codecFingerprint,
        declaredPackets,
        packets: 0,
        startPts: Infinity,
        endPts: -Infinity,
        previousDts: -Infinity,
      };
    });
    const byIndex = new Map(streams.map((stream) => [stream.index, stream]));
    const videoTimes = new Map<number, number>();
    const context = input.getFormatContext();
    const interrupt = () => input.interrupt();
    signal.addEventListener("abort", interrupt, { once: true });
    using packet = new Packet();
    packet.alloc();
    let count = 0;
    try {
      // The high-level iterator folds read failures into EOF. Reading through
      // the owned native context preserves errors and original packet clocks.
      while (true) {
        checkSignal(signal);
        const result = await context.readFrame(packet);
        checkSignal(signal);
        if (result === AVERROR_EOF) break;
        if (result < 0) throw invalidMedia();
        try {
          const stream = byIndex.get(packet.streamIndex);
          const pts = timestamp(packet.pts);
          const dts = timestamp(packet.dts);
          const duration = timestamp(packet.duration);
          if (
            !stream ||
            ++count > limits.packets ||
            packet.size <= 0 ||
            packet.size > limits.packetBytes ||
            (packet.flags & AV_PKT_FLAG_CORRUPT) !== 0 ||
            duration <= 0 ||
            dts <= stream.previousDts ||
            !Number.isSafeInteger(pts + duration)
          )
            throw invalidMedia();
          stream.packets++;
          stream.startPts = Math.min(stream.startPts, pts);
          stream.endPts = Math.max(stream.endPts, pts + duration);
          stream.previousDts = dts;
          if (stream.index === video.index) {
            if (videoTimes.has(pts)) throw invalidMedia();
            videoTimes.set(pts, duration);
          }
        } finally {
          packet.unref();
        }
      }
    } finally {
      signal.removeEventListener("abort", interrupt);
    }
    checkSignal(signal);
    if (
      streams.some(
        (stream) =>
          stream.packets === 0 ||
          (stream.declaredPackets > 0 &&
            stream.packets !== stream.declaredPackets),
      )
    )
      throw invalidMedia();
    const videoPackets = byIndex.get(video.index);
    if (!videoPackets) throw invalidMedia();
    const formatStartMs =
      context.startTime === AV_NOPTS_VALUE
        ? (videoPackets.startPts * videoPackets.timeBaseNumerator * 1000) /
          videoPackets.timeBaseDenominator
        : timestamp(context.startTime) / 1000;
    const actualDurationMs =
      Math.max(
        ...streams.map(
          (stream) =>
            (stream.endPts * stream.timeBaseNumerator * 1000) /
            stream.timeBaseDenominator,
        ),
      ) - formatStartMs;
    if (
      !Number.isFinite(formatStartMs) ||
      !Number.isFinite(actualDurationMs) ||
      actualDurationMs <= 0 ||
      actualDurationMs > maxDurationMs
    )
      throw invalidMedia();
    return {
      actualDurationMs,
      width,
      height,
      videoPackets: videoPackets.packets,
      videoTimeline: [...videoTimes.entries()]
        .toSorted(([left], [right]) => left - right)
        .map(([pts, duration]) => ({
          offsetMs:
            (pts * videoPackets.timeBaseNumerator * 1000) /
              videoPackets.timeBaseDenominator -
            formatStartMs,
          durationMs:
            (duration * videoPackets.timeBaseNumerator * 1000) /
            videoPackets.timeBaseDenominator,
        })),
      streams: streams.map(({ codecFingerprint, codecType, sampleRate }) => ({
        codecFingerprint,
        codecType,
        sampleRate,
      })),
    };
  } catch {
    checkSignal(signal);
    throw invalidMedia();
  }
}

async function ffmpeg(executable: string, args: string[], signal: AbortSignal) {
  return runFfmpeg(
    executable,
    [
      "-xerror",
      "-max_alloc",
      String(limits.packetBytes),
      "-max_pixels",
      String(frameLimits.maxPixels),
      ...args,
    ],
    signal,
    limits.fingerprintBytes,
  );
}

function parseFingerprints(
  text: string,
  metadata: Awaited<ReturnType<typeof inspectRecording>>,
) {
  const lines = text.split(/\r?\n/);
  if (
    !lines.some((line) => /^#tb 0:\s*1\/90000$/.test(line)) ||
    !lines.some((line) => /^#hash:\s*MD5$/.test(line)) ||
    !lines.some((line) => /^#codec_id 0:\s*rawvideo$/.test(line)) ||
    !lines.some(
      (line) =>
        line.trim() === `#dimensions 0: ${metadata.width}x${metadata.height}`,
    )
  )
    throw invalidMedia();
  let previous = -1;
  const frames = lines
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line, index) => {
      // framemd5's fixed packet record is five integers and one MD5 value.
      const fields =
        /^\s*0,\s*(-?\d+),\s*(-?\d+),\s*(\d+),\s*(\d+),\s*([0-9a-f]{32})\s*$/.exec(
          line,
        );
      if (!fields) throw invalidMedia();
      const [, dtsValue, ptsValue, durationValue, sizeValue, value] = fields;
      const dts = Number(dtsValue);
      const pts = Number(ptsValue);
      const duration = Number(durationValue);
      const size = Number(sizeValue);
      if (
        !value ||
        ![dts, pts, duration, size].every(Number.isSafeInteger) ||
        pts <= previous ||
        pts < 0 ||
        dts !== pts ||
        duration <= 0 ||
        size !== metadata.width * metadata.height * 3 ||
        pts / 90 >= metadata.actualDurationMs ||
        Math.abs(
          pts / 90 - (metadata.videoTimeline[index]?.offsetMs ?? Infinity),
        ) >
          1 / 90 + 0.000001
      )
        throw invalidMedia();
      previous = pts;
      return {
        value,
        width: metadata.width,
        height: metadata.height,
        offsetMs: pts / 90,
        durationMs: duration / 90,
      };
    });
  if (frames.length === 0 || frames.length !== metadata.videoPackets)
    throw invalidMedia();
  return frames;
}

export async function fingerprintRecording(
  file: string,
  metadata: Awaited<ReturnType<typeof inspectRecording>>,
  executable: string,
  signal: AbortSignal,
) {
  const output = await ffmpeg(
    executable,
    [
      "-protocol_whitelist",
      "file",
      "-err_detect",
      "explode",
      "-copyts",
      "-start_at_zero",
      "-noautorotate",
      "-i",
      file,
      "-map",
      "0:v:0",
      "-an",
      "-sn",
      "-dn",
      "-threads",
      "1",
      "-filter_threads",
      "1",
      "-fps_mode",
      "passthrough",
      "-c:v",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-enc_time_base",
      "1:90000",
      "-avoid_negative_ts",
      "disabled",
      "-f",
      "framemd5",
      "-format_version",
      "1",
      "pipe:1",
    ],
    signal,
  );
  checkSignal(signal);
  return parseFingerprints(output, metadata);
}

export async function encodeRecording(
  inputs: readonly {
    path: string;
    media: Awaited<ReturnType<typeof inspectRecording>>;
  }[],
  destination: string,
  executable: string,
  signal: AbortSignal,
) {
  checkSignal(signal);
  const directory = dirname(destination);
  if (
    !isAbsolute(destination) ||
    resolve(destination) !== destination ||
    !/^[a-zA-Z0-9-]+\.mp4$/.test(basename(destination)) ||
    inputs.length === 0 ||
    inputs.length > limits.files ||
    new Set(inputs.map((input) => input.path)).size !== inputs.length ||
    inputs.some(
      ({ path: file }) =>
        dirname(file) !== directory ||
        !/^segment-\d+\.mp4$/.test(basename(file)) ||
        file === destination,
    )
  )
    throw invalidMedia();
  const metadata = inputs.map((input) => input.media);
  const first = metadata[0]!;
  const totalDurationMs = metadata.reduce(
    (sum, item) => sum + item.actualDurationMs,
    0,
  );
  if (
    totalDurationMs > limits.totalMs ||
    metadata.some(
      (item) =>
        item.streams.length !== first.streams.length ||
        item.streams.some(
          (stream, index) =>
            stream.codecFingerprint !== first.streams[index]?.codecFingerprint,
        ),
    )
  )
    throw invalidMedia();
  const id = crypto.randomUUID();
  const list = join(directory, `.recording-${id}.ffconcat`);
  const output = join(directory, `recording-${id}.mp4`);
  let cleanupSafe = true;
  try {
    await writeFile(
      list,
      [
        "ffconcat version 1.0",
        ...metadata.flatMap((item, index) => {
          const file = inputs[index]?.path;
          if (!file) throw invalidMedia();
          return [
            `file '${basename(file)}'`,
            `duration ${item.actualDurationMs / 1000}`,
          ];
        }),
        "",
      ].join("\n"),
      { flag: "wx", mode: 0o600, signal },
    );
    await writeFile(output, "", { flag: "wx", mode: 0o600, signal });
    await ffmpeg(
      executable,
      [
        "-protocol_whitelist",
        "file",
        "-err_detect",
        "explode",
        "-copyts",
        "-start_at_zero",
        "-f",
        "concat",
        "-safe",
        "1",
        "-i",
        list,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-sn",
        "-dn",
        "-vf",
        "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
        "-filter_threads",
        "1",
        "-fps_mode",
        "passthrough",
        "-enc_time_base:v",
        "1:90000",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "25",
        "-pix_fmt",
        "yuv420p",
        "-threads:v",
        "1",
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        "-threads:a",
        "1",
        "-avoid_negative_ts",
        "disabled",
        "-movflags",
        "+faststart",
        "-video_track_timescale",
        "90000",
        "-fs",
        String(limits.fileBytes),
        "-f",
        "mp4",
        output,
      ],
      signal,
    );
    const result = await inspectRecording(output, signal, limits.totalMs);
    let mediaStartMs = 0;
    const segmentBoundaries = metadata.map((item) => {
      const start = mediaStartMs;
      mediaStartMs += item.actualDurationMs;
      return { mediaStartMs: start, mediaEndMs: mediaStartMs };
    });
    const expectedTimeline = metadata.flatMap((item, index) => {
      const boundary = segmentBoundaries[index];
      if (!boundary) throw invalidMedia();
      return item.videoTimeline.map(
        (frame) => boundary.mediaStartMs + frame.offsetMs,
      );
    });
    const encodedAudio = result.streams.find(
      (stream) => stream.codecType === AVMEDIA_TYPE_AUDIO,
    );
    // AAC can extend the final audio packet by at most one 1024-sample block.
    // Video PTS are independently checked at the output's 90 kHz resolution.
    const timestampToleranceMs = 1 / 90 + 0.000001;
    const durationToleranceMs =
      (encodedAudio && encodedAudio.sampleRate > 0
        ? (1024 * 1000) / encodedAudio.sampleRate
        : 0) + timestampToleranceMs;
    if (
      result.width > 1280 ||
      result.height > 720 ||
      result.videoPackets !== expectedTimeline.length ||
      result.videoTimeline.some(
        (frame, index) =>
          Math.abs(frame.offsetMs - (expectedTimeline[index] ?? Infinity)) >
          timestampToleranceMs,
      ) ||
      Math.abs(result.actualDurationMs - totalDurationMs) > durationToleranceMs
    )
      throw invalidMedia();
    checkSignal(signal);
    await rename(output, destination);
    return {
      actualDurationMs: result.actualDurationMs,
      segmentBoundaries: segmentBoundaries.map((segment) => ({
        ...segment,
        mediaEndMs: Math.min(segment.mediaEndMs, result.actualDurationMs),
      })),
    };
  } catch (error) {
    if (error instanceof MediaCleanupError) {
      cleanupSafe = false;
      throw error;
    }
    checkSignal(signal);
    // Native codec and filesystem errors can expose media diagnostics or paths.
    // oxlint-disable-next-line eslint/preserve-caught-error
    throw new Error("recording_encoding_failed");
  } finally {
    if (cleanupSafe)
      await Promise.all([
        rm(list, { force: true }),
        rm(output, { force: true }),
      ]).catch(() => {
        throw new MediaCleanupError("Recording temporary file cleanup failed");
      });
  }
}
