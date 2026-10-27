import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MediaCleanupError } from "../../media/resources";
import { runFfmpeg } from "../../media/ffmpeg";

export async function readAudioRange({
  start,
  end,
  parts,
  executable,
  signal,
}: {
  start: number;
  end: number;
  parts: {
    startedAt: number;
    endedAt: number;
    bytes: number;
    open: () => ReadableStream<Uint8Array>;
  }[];
  executable: string;
  signal: AbortSignal;
}) {
  signal.throwIfAborted();
  const sampleMs = 1000 / 16_000;
  const selected: {
    part: (typeof parts)[number];
    from: number;
    until: number;
  }[] = [];
  let cursor = start;
  for (const part of parts.toSorted((a, b) => a.startedAt - b.startedAt)) {
    if (cursor >= end) break;
    if (part.endedAt <= cursor) continue;
    if (part.startedAt - cursor > sampleMs)
      throw new Error("Audio range has a recording gap");
    const until = Math.min(end, part.endedAt);
    selected.push({
      part,
      from: cursor - part.startedAt,
      until: until - part.startedAt,
    });
    cursor = until;
  }
  if (end - cursor > sampleMs)
    throw new Error("Audio range is not fully recorded");
  const maxBytes = 64 * 1024 * 1024;
  if (selected.reduce((bytes, { part }) => bytes + part.bytes, 0) > maxBytes)
    throw new Error("Audio range exceeds the media byte budget");

  const directory = await mkdtemp(join(tmpdir(), "analysis-audio-"));
  let cleanupSafe = true;
  try {
    const inputs: string[] = [];
    const filters: string[] = [];
    for (const [index, { part, from, until }] of selected.entries()) {
      signal.throwIfAborted();
      const path = join(directory, `${index}.m4a`);
      await pipeline(Readable.fromWeb(part.open()), createWriteStream(path), {
        signal,
      });
      inputs.push("-i", path);
      filters.push(
        `[${index}:a]atrim=start=${from / 1000}:end=${until / 1000},asetpts=PTS-STARTPTS[a${index}]`,
      );
    }
    filters.push(
      selected.map((_, index) => `[a${index}]`).join("") +
        `concat=n=${selected.length}:v=0:a=1[out]`,
    );
    const output = join(directory, "audio.m4a");
    await runFfmpeg(
      executable,
      [
        ...inputs,
        "-filter_complex_threads",
        "1",
        "-filter_complex",
        filters.join(";"),
        "-map",
        "[out]",
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        "-threads:a",
        "1",
        "-fs",
        String(maxBytes),
        "-movflags",
        "+faststart",
        "-f",
        "ipod",
        output,
      ],
      signal,
      4096,
    );
    if ((await stat(output)).size >= maxBytes)
      throw new Error("Audio range exceeds the media byte budget");
    signal.throwIfAborted();
    return new Uint8Array(await readFile(output));
  } catch (cause) {
    if (cause instanceof MediaCleanupError) cleanupSafe = false;
    throw cause;
  } finally {
    if (cleanupSafe) await rm(directory, { recursive: true, force: true });
  }
}
