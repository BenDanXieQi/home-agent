import { mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { identityEnrollmentLimits } from "@home-agent/api/contracts";
import { runFfmpeg } from "../../media/ffmpeg";
import profile from "./profile.json";

// Files remain under the bounded upload's temporary directory and share its lifetime.
export async function extractReferenceFrames(
  executable: string,
  path: string,
  signal: AbortSignal,
) {
  const directory = join(dirname(path), "frames");
  await mkdir(directory);
  await runFfmpeg(
    executable,
    [
      "-max_alloc",
      "33554432",
      "-max_pixels",
      "8294400",
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      "matroska,webm,mov",
      "-i",
      path,
      "-map",
      "0:v:0",
      "-an",
      "-sn",
      "-dn",
      "-t",
      String(identityEnrollmentLimits.captureMs / 1000),
      "-frames:v",
      String(
        identityEnrollmentLimits.captureMs /
          identityEnrollmentLimits.intervalMs,
      ),
      "-threads",
      "1",
      "-filter_threads",
      "1",
      "-vf",
      `fps=${1000 / identityEnrollmentLimits.intervalMs},scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease`,
      "-q:v",
      "2",
      join(directory, "%03d.jpg"),
    ],
    signal,
    64 * 1024,
  );
  const names = (await readdir(directory))
    .filter((name) => /^\d{3}\.jpg$/.test(name))
    .toSorted();
  if (!names.length) throw new Error("Recording has no decodable frames");
  return names.map((name, index) => ({
    path: join(directory, name),
    offsetMs: index * identityEnrollmentLimits.intervalMs,
  }));
}
