import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WindowEncodingInput } from "./encoding-input";
import { windowLimits } from "../window/limits";

export class MediaCleanupError extends Error {}

async function ffmpeg(executable: string, args: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  const child = spawn(
    executable,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-threads",
      "1",
      ...args,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let diagnostic = "";
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-1024);
  });
  const abort = () => {
    child.kill("SIGKILL");
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    const [code] = await once(child, "close");
    if (code !== 0) throw new Error(`Media encoding failed: ${diagnostic}`);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

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
      await writeFile(
        join(directory, "frames.rgb"),
        frames.map((frame) => frame.rgb),
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
      await writeFile(
        join(directory, "audio.pcm"),
        audio.map(({ pcm }) =>
          Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
        ),
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
    args.push("-t", "5", "-fs", String(windowLimits.productBytes));
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
    await ffmpeg(executable, args, signal);
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
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(
      (cause: unknown) => {
        throw new MediaCleanupError("Media temporary file cleanup failed", {
          cause,
        });
      },
    );
  }
}
