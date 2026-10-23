import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { Decoder, Demuxer } from "node-av/api";
import {
  AV_FRAME_FLAG_CORRUPT,
  AV_NOPTS_VALUE,
  AV_PKT_FLAG_CORRUPT,
  AVSEEK_FLAG_BACKWARD,
} from "node-av/constants";
import { FFmpegError } from "node-av/lib";
import { RecordingCoverageError, requireCoverage } from "./selection";
import type { transformMedia } from "./transform";

export async function decodedFrames(
  list: string,
  seekStart: number,
  end: number,
  signal: AbortSignal,
) {
  await using input = await Demuxer.open(list, {
    format: "concat",
    copyTs: true,
    signal,
    options: { safe: false, protocol_whitelist: "file" },
  });
  const video = input.video();
  if (!video) throw new RecordingCoverageError("Recording has no video stream");
  if (seekStart > 0)
    FFmpegError.throwIfError(
      await input.seek(seekStart, -1, AVSEEK_FLAG_BACKWARD),
      "Recording coverage seek failed",
    );
  using decoder = await Decoder.create(video, { exitOnError: false, signal });
  const packetTimes = new Map<number, boolean>();
  const videoIndex = video.index;
  const packetScale = (1000 * video.timeBase.num) / video.timeBase.den;
  async function* packets() {
    for await (const packet of input.packets(videoIndex)) {
      if (!packet) {
        yield null;
        break;
      }
      if (packet.pts !== AV_NOPTS_VALUE) {
        const at = Number(packet.pts) * packetScale;
        packetTimes.set(
          at,
          (packetTimes.get(at) ?? false) ||
            (packet.flags & AV_PKT_FLAG_CORRUPT) !== 0,
        );
      }
      yield packet;
    }
  }
  const frames: Parameters<typeof requireCoverage>[0] = [];
  for await (const frame of decoder.frames(packets())) {
    if (!frame) break;
    try {
      signal.throwIfAborted();
      if (
        frame.pts === AV_NOPTS_VALUE ||
        frame.decodeErrorFlags !== 0 ||
        frame.hasFlags(AV_FRAME_FLAG_CORRUPT)
      )
        continue;
      const timeBase = frame.timeBase.num ? frame.timeBase : video.timeBase;
      const scale = (1000 * timeBase.num) / timeBase.den;
      const offsetMs = Number(frame.pts) * scale;
      const durationMs = Number(frame.duration) * scale;
      if (
        Number.isFinite(offsetMs) &&
        Number.isFinite(durationMs) &&
        durationMs >= 0
      ) {
        frames.push({ offsetMs, durationMs });
        if (offsetMs >= end) break;
      }
    } finally {
      frame.free();
    }
  }
  const times = [...packetTimes.keys()].toSorted((left, right) => left - right);
  let next = 0;
  return frames
    .toSorted((left, right) => left.offsetMs - right.offsetMs)
    .map((frame) => {
      while (next < times.length && times[next]! <= frame.offsetMs + 0.000001)
        next++;
      return {
        offsetMs: frame.offsetMs,
        durationMs:
          next < times.length
            ? times[next]! - frame.offsetMs
            : frame.durationMs,
      };
    })
    .filter(
      (frame) => frame.durationMs > 0 && !packetTimes.get(frame.offsetMs),
    );
}

export async function prepareTimeline(
  options: Parameters<typeof transformMedia>[0],
) {
  const { input, signal } = options;
  const candidates = options.segments.toSorted(
    (left, right) => left.startedAt - right.startedAt,
  );
  const selectionStart =
    input.selection.kind === "at" ? input.selection.at : input.selection.start;
  const selectionEnd =
    input.selection.kind === "at"
      ? selectionStart + 0.001
      : input.selection.end;
  const overlaps = (entry: (typeof candidates)[number]) =>
    entry.endedAt > selectionStart && entry.startedAt < selectionEnd;
  let firstIndex = candidates.findIndex(overlaps);
  let lastIndex = candidates.findLastIndex(overlaps);
  if (firstIndex < 0)
    throw new RecordingCoverageError("Recording selection has no material");
  const fingerprint = candidates[firstIndex]!.media.codecFingerprint;
  if (
    candidates
      .slice(firstIndex, lastIndex + 1)
      .some((entry) => entry.media.codecFingerprint !== fingerprint)
  )
    throw new RecordingCoverageError(
      "Recording selection changes media parameters",
    );

  while (
    firstIndex > 0 &&
    candidates[firstIndex - 1]!.media.codecFingerprint === fingerprint
  )
    firstIndex--;
  while (
    lastIndex + 1 < candidates.length &&
    candidates[lastIndex + 1]!.media.codecFingerprint === fingerprint
  )
    lastIndex++;
  const segments = candidates.slice(firstIndex, lastIndex + 1);
  const first = segments[0]!;
  for (let index = 1; index < segments.length; index++) {
    const previous = segments[index - 1]!;
    const current = segments[index]!;
    const continuous =
      previous.sequence !== undefined &&
      current.sequence === previous.sequence + 1 &&
      previous.runId !== undefined &&
      current.runId === previous.runId;
    if (
      !continuous &&
      Math.max(previous.endedAt, selectionStart) <
        Math.min(current.startedAt, selectionEnd)
    )
      throw new RecordingCoverageError(
        "Recording selection has missing segments",
      );
  }
  const list = join(options.directory, `input-${crypto.randomUUID()}.ffconcat`);
  await pipeline(
    Readable.from([
      [
        "ffconcat version 1.0",
        ...segments.flatMap((segment, index) => {
          const info = segment.media;
          const next = segments[index + 1];
          const nextMedia = next?.media;
          const durationMs =
            next && nextMedia
              ? next.startedAt -
                segment.startedAt +
                (nextMedia.formatStartPtsMs - nextMedia.startPtsMs) -
                (info.formatStartPtsMs - info.startPtsMs)
              : info.endPtsMs - info.formatStartPtsMs;
          return [
            `file '${segment.path.replace(/'/g, "'\\''")}'`,
            `duration ${durationMs / 1000}`,
          ];
        }),
        "",
      ].join("\n"),
    ]),
    await options.openOutput(list),
    { signal },
  );
  const ffmpegInput = [
    "-copyts",
    "-f",
    "concat",
    "-safe",
    "0",
    "-protocol_whitelist",
    "file",
    "-i",
    list,
  ];
  const firstMedia = first.media;
  const origin =
    first.startedAt + firstMedia.formatStartPtsMs - firstMedia.startPtsMs;
  const { selection } = input;
  const requestedStart =
    (selection.kind === "at" ? selection.at : selection.start) - origin;
  const requestedEnd =
    selection.kind === "range"
      ? selection.end - origin
      : requestedStart + 0.001;
  // Retain reference frames from the preceding segment for open GOP video.
  const sourceIndex = Math.max(
    0,
    segments.findLastIndex((segment) => segment.startedAt <= selectionStart) -
      1,
  );
  const source = segments[sourceIndex]!;
  const sourceMedia = source.media;
  const seekStart = Math.max(
    0,
    (source.startedAt -
      origin +
      sourceMedia.formatStartPtsMs -
      sourceMedia.startPtsMs) /
      1000,
  );

  return {
    list,
    media: segments.map((segment) => segment.media),
    ffmpegInput,
    origin,
    requestedStart,
    requestedEnd,
    seekStart,
  };
}
