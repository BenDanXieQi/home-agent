import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { Plugin } from "vite";

/** Produce transport variants once at build time, including copied public files. */
export function precompress() {
  let outputDirectory = "";
  let write = false;
  return {
    name: "precompress-static-files",
    apply: "build",
    configResolved(config) {
      outputDirectory = resolve(config.root, config.build.outDir);
      write = config.build.write;
    },
    async closeBundle() {
      if (!write) return;
      const entries = await readdir(outputDirectory, {
        recursive: true,
        withFileTypes: true,
      });
      await Promise.all(
        entries
          .filter(
            (entry) =>
              entry.isFile() && /\.(?:html|js|css|svg)$/.test(entry.name),
          )
          .map(async (entry) => {
            const path = join(entry.parentPath, entry.name);
            const content = await readFile(path);
            const variants = [
              [
                "br",
                brotliCompressSync(content, {
                  params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
                }),
              ],
              ["gz", gzipSync(content, { level: 9 })],
            ] as const;
            await Promise.all(
              variants.map(async ([extension, compressed]) => {
                if (compressed.length < content.length)
                  await writeFile(`${path}.${extension}`, compressed);
                else await rm(`${path}.${extension}`, { force: true });
              }),
            );
          }),
      );
    },
  } satisfies Plugin;
}
