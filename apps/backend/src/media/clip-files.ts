import { chmod, lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export async function prepareClipDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory())
    throw new Error("Clip cache path must be a directory, not a symbolic link");
  await chmod(directory, 0o700);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (
      (entry.isFile() && /^[0-9a-f-]{36}\.(mp4|jpg)$/.test(entry.name)) ||
      (entry.isDirectory() &&
        /^(?:\.encoding-|instance-|product-)[A-Za-z0-9]+$/.test(entry.name))
    )
      await rm(join(directory, entry.name), {
        recursive: entry.isDirectory(),
        force: true,
      });
  }
}

export async function storageBytes(path: string) {
  const info = await stat(path).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  });
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  const entries = await readdir(path, { recursive: true, withFileTypes: true });
  const sizes = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const file = await stat(join(entry.parentPath, entry.name)).catch(
          (cause: unknown) => {
            if (
              cause instanceof Error &&
              "code" in cause &&
              cause.code === "ENOENT"
            )
              return undefined;
            throw cause;
          },
        );
        return file?.size ?? 0;
      }),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}
