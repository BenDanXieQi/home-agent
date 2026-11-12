import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import type { mediaAnalysisInputSchema } from "@home-agent/agent/media-analysis/session";
import { readLimitedBytes } from "@home-agent/api/http/read-body";
import { runFfmpeg } from "../media/ffmpeg";
import { MediaCleanupError } from "../media/resources";
import type { createPerceptionService } from "../perception/service";
import type { createRecordingsService } from "../recordings/service";

const maxBytes = 64 * 1024 * 1024;

export async function readAnalysisMedia({
  input,
  scopeEpoch,
  recordings,
  perception,
  executable,
  signal: requestSignal,
}: {
  input: z.infer<typeof mediaAnalysisInputSchema>;
  scopeEpoch: string;
  recordings: Pick<ReturnType<typeof createRecordingsService>, "readMedia">;
  perception: Pick<
    ReturnType<typeof createPerceptionService>,
    "readAudioRange"
  >;
  executable: string;
  signal: AbortSignal;
}) {
  const controller = new AbortController();
  const signal = AbortSignal.any([requestSignal, controller.signal]);

  async function readVideo() {
    const result = await recordings.readMedia(
      {
        deviceId: input.source.deviceId,
        channel: input.source.channel,
        source: "local",
        selection: {
          kind: "range",
          start: input.startedAt,
          end: input.endedAt,
        },
        output: { kind: "video", codec: "h264", fps: 1, height: 512 },
      },
      signal,
    );
    const media = result.media[0];
    const { startedAt, endedAt } = result.metadata;
    if (
      result.media.length !== 1 ||
      !media ||
      result.metadata.items[0]?.contentType !== "video/mp4" ||
      startedAt === undefined ||
      endedAt === undefined
    )
      throw new Error("Expected one original recording video");

    const data = await readLimitedBytes(new Response(media), maxBytes, signal);
    if (!data.length) throw new Error("Original recording video is empty");
    return { data, contentType: "video/mp4" as const, startedAt, endedAt };
  }

  try {
    signal.throwIfAborted();
    const video = input.kind === "video" ? await readVideo() : undefined;
    if (!input.includeAudio) {
      if (!video) throw new Error("Audio range has no audio input");
      return video;
    }

    const audio = await perception.readAudioRange(
      {
        ...input.source,
        scopeEpoch,
        start: input.startedAt,
        end: input.endedAt,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!audio.length || audio.byteLength > maxBytes)
      throw new Error("Audio range exceeds the media byte budget or is empty");

    const directory = await mkdtemp(join(tmpdir(), "analysis-media-"));
    let cleanupSafe = true;
    try {
      const audioPath = join(directory, "audio.m4a");
      await writeFile(audioPath, audio, { signal });
      const args = ["-i", audioPath];
      if (video) {
        const videoPath = join(directory, "video.mp4");
        await writeFile(videoPath, video.data, { signal });
        args.push(
          "-itsoffset",
          String((video.startedAt - input.startedAt) / 1000),
          "-i",
          videoPath,
          "-map",
          "1:v:0",
          "-c:v",
          "copy",
        );
      }
      args.push("-map", "0:a:0", "-c:a", video ? "copy" : "libmp3lame");
      if (!video) args.push("-b:a", "64k", "-threads:a", "1");
      args.push(
        "-t",
        String((input.endedAt - input.startedAt) / 1000),
        "-fs",
        String(maxBytes),
      );
      if (video)
        args.push("-avoid_negative_ts", "disabled", "-movflags", "+faststart");
      const output = join(directory, video ? "media.mp4" : "audio.mp3");
      args.push(output);
      await runFfmpeg(executable, args, signal, 4096);
      const { size } = await stat(output);
      if (!size || size >= maxBytes)
        throw new Error(
          "Analysis media exceeds the media byte budget or is empty",
        );

      const data = new Uint8Array(await readFile(output));
      signal.throwIfAborted();
      return {
        data,
        contentType: video ? ("video/mp4" as const) : ("audio/mpeg" as const),
        startedAt: input.startedAt,
        endedAt: input.endedAt,
      };
    } catch (cause) {
      if (cause instanceof MediaCleanupError) cleanupSafe = false;
      throw cause;
    } finally {
      if (cleanupSafe) await rm(directory, { recursive: true, force: true });
    }
  } finally {
    controller.abort(new Error("Analysis media read completed"));
  }
}
