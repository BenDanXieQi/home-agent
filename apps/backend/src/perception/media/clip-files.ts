import { chmod, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

// This is a disposable cache owned by one backend instance, never a media library.
// Only our generated names are removed after an interrupted previous session.
export async function prepareClipDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory())
    throw new Error("Clip cache path must be a directory, not a symbolic link");
  await chmod(directory, 0o700);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (
      (entry.isFile() && /^[0-9a-f-]{36}\.(mp4|jpg)$/.test(entry.name)) ||
      (entry.isDirectory() && /^\.encoding-[A-Za-z0-9]+$/.test(entry.name))
    )
      await rm(join(directory, entry.name), {
        recursive: entry.isDirectory(),
        force: true,
      });
  }
}
