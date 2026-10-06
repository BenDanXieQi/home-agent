import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mkdtemp, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WindowEncodingInput } from "./encoding-input";
import { windowLimits } from "../window/limits";

import { MediaCleanupError } from "../../media/resources";
import { runFfmpeg } from "../../media/ffmpeg";

export async function encodeWindow(
  entry: WindowEncodingInput,
  executable: string,
  signal: AbortSignal,
  destination: string,
) {
  const { representation, parameters, audio } = entry;
  const image = representation.endsWith("image");
  const frames = image ? entry.frames.slice(-1) : entry.frames;
  signal.throwIfAborted();
  if (representation === "audio" && !parameters.audioIncluded)
    throw new Error("Continuous audio input unavailable");
  if (representation !== "audio" && !frames.length)
    throw new Error("Video input unavailable");
  const directory = await mkdtemp(join(dirname(destination), ".encoding-"));
  let cleanupSafe = true;
  try {
    const args: string[] = [];
    if (representation !== "audio") {
      const first = frames[0]!;
      if (
        frames.some(
          (frame) =>
            frame.retainedWidth !== first.retainedWidth ||
            frame.retainedHeight !== first.retainedHeight,
        )
      )
        throw new Error("Window frame dimensions changed");
      await pipeline(
        Readable.from(frames.map((frame) => frame.rgb)),
        createWriteStream(join(directory, "frames.rgb")),
        { signal },
      );
      args.push(
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgb24",
        "-video_size",
        `${first.retainedWidth}x${first.retainedHeight}`,
        "-framerate",
        "1000",
        "-i",
        join(directory, "frames.rgb"),
      );
    }
    if (parameters.audioIncluded) {
      await pipeline(
        Readable.from(
          audio.map(({ pcm }) =>
            Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
          ),
        ),
        createWriteStream(join(directory, "audio.pcm")),
        { signal },
      );

      args.push(
        "-f",
        "s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-i",
        join(directory, "audio.pcm"),
      );
    }
    if (representation !== "audio") {
      const crop = parameters.cropPixels;
      // Raw frames carry no timestamps. Map each actual frame to its recorded time;
      // passthrough output never manufactures frames to fill the intervals.
      const timestamps = parameters.frames.map((frame) => frame.offsetMs);
      const pts = timestamps.reduceRight(
        (rest, at, index) =>
          index === timestamps.length - 1
            ? String(at)
            : `if(eq(N,${index}),${at},${rest})`,
        "0",
      );
      const filters = [
        ...(crop
          ? [`crop=${crop.width}:${crop.height}:${crop.left}:${crop.top}`]
          : []),
        `scale=${parameters.width}:${parameters.height}`,
        `settb=1/1000`,
        `setpts='${pts}'`,
        "setsar=1",
      ];
      args.push(
        "-map",
        "0:v:0",
        "-vf",
        filters.join(","),
        "-filter_threads",
        "1",
        "-fps_mode",
        "passthrough",
        "-enc_time_base",
        "1:1000",
        "-threads",
        "1",
      );
      if (image)
        args.push(
          "-c:v",
          "mjpeg",
          "-q:v",
          "2",
          "-frames:v",
          "1",
          "-pix_fmt",
          "yuvj420p",
        );
      else
        args.push(
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-crf",
          "25",
          "-pix_fmt",
          "yuv420p",
        );
    }
    if (parameters.audioIncluded)
      args.push(
        "-map",
        representation === "audio" ? "0:a:0" : "1:a:0",
        "-af",
        `asetpts=PTS-STARTPTS+${(audio[0]!.startedAt - parameters.startedAt) / 1000}/TB`,
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        "-threads",
        "1",
      );
    else args.push("-an");
    const output = join(directory, image ? "media.jpg" : "media.mp4");
    const durationSeconds = Math.max(
      5,
      (parameters.endedAt - parameters.startedAt) / 1000,
    );
    args.push(
      "-t",
      String(durationSeconds),
      "-fs",
      String(windowLimits.productBytes),
    );
    if (image) args.push("-f", "image2", "-update", "1");
    else
      args.push(
        "-avoid_negative_ts",
        "disabled",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
      );
    args.push(output);
    await runFfmpeg(executable, args, signal, 1024);
    const metadata = await stat(output);
    if (metadata.size >= windowLimits.productBytes)
      throw new Error("Media product exceeded byte budget");
    signal.throwIfAborted();
    await rename(output, destination);
    return {
      bytes: metadata.size,
      contentType: image
        ? "image/jpeg"
        : representation === "audio"
          ? "audio/mp4"
          : "video/mp4",
    };
  } catch (cause) {
    if (cause instanceof MediaCleanupError) cleanupSafe = false;
    throw cause;
  } finally {
    if (cleanupSafe)
      await rm(directory, { recursive: true, force: true }).catch(
        (cause: unknown) => {
          throw new MediaCleanupError("Media temporary file cleanup failed", {
            cause,
          });
        },
      );
  }
}
