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
  const { parameters, audio } = entry;
  signal.throwIfAborted();
  if (!parameters.audioIncluded || !audio.length)
    throw new Error("Continuous audio input unavailable");
  const directory = await mkdtemp(join(dirname(destination), ".encoding-"));
  let cleanupSafe = true;
  try {
    await pipeline(
      Readable.from(
        audio.map(({ pcm }) =>
          Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
        ),
      ),
      createWriteStream(join(directory, "audio.pcm")),
      { signal },
    );
    const output = join(directory, "media.mp4");
    const args = [
      "-f",
      "s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-i",
      join(directory, "audio.pcm"),
      "-map",
      "0:a:0",
      "-af",
      "asetpts=PTS-STARTPTS",
      "-c:a",
      "aac",
      "-b:a",
      "64k",
      "-threads",
      "1",
    ];
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
      contentType: "audio/mp4",
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
