import { mkdir, open, readdir, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { referenceStorageLimits } from "./contracts";

/** Private directory only: keys are generated UUIDs, never request paths. */
export function createReferenceFiles(directory: string) {
  const root = resolve(directory);
  const path = (key: string) => join(root, z.uuid().parse(key));
  return {
    async write(key: string, bytes: Uint8Array) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const file = await open(path(key), "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
    },
    async read(key: string, expectedBytes: number) {
      const file = await open(
        path(key),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.size !== expectedBytes ||
          stat.size > referenceStorageLimits.imageBytes
        )
          throw new Error("Invalid identity reference image");
        const bytes = Buffer.alloc(stat.size + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== stat.size)
          throw new Error("Identity reference image changed during read");
        return bytes.subarray(0, bytesRead);
      } finally {
        await file.close();
      }
    },
    async listKeys() {
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return [];
        throw error;
      }
      return entries
        .filter((entry) => z.uuid().safeParse(entry.name).success)
        .map((entry) => entry.name);
    },
    async remove(keys: string[]) {
      for (const key of keys) {
        try {
          await unlink(path(key));
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
          )
            throw error;
        }
      }
    },
  };
}
