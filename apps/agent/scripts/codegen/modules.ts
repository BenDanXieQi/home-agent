import { Glob } from "bun";
import { watch } from "node:fs";

export function scanModules(directory: string, pattern: string) {
  const files = Array.from(new Glob(pattern).scanSync(directory)).toSorted();
  if (!files.length) throw new Error(`No modules matching ${pattern}`);
  return files;
}

export function validateModuleNames(names: string[]) {
  const seen = new Set<string>();
  for (const name of names) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name))
      throw new Error(`Invalid module name: ${name}`);
    if (seen.has(name)) throw new Error(`Duplicate module name: ${name}`);
    seen.add(name);
  }
}

export async function writeGeneratedFile(outputPath: string, source: string) {
  const formatted = Bun.spawnSync(
    ["bunx", "--no-install", "oxfmt", "--stdin-filepath", outputPath],
    {
      stdin: new TextEncoder().encode(source),
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  if (formatted.exitCode !== 0)
    throw new Error(`Failed to format generated module: ${outputPath}`);
  const content = new TextDecoder().decode(formatted.stdout);
  const output = Bun.file(outputPath);
  if (!(await output.exists()) || (await output.text()) !== content)
    await Bun.write(outputPath, content);
}

export function watchModules(
  directories: URL[],
  generate: () => Promise<void>,
) {
  let generation = Promise.resolve();
  const watchers = directories.map((directory) =>
    watch(directory, { recursive: true }, (_event, filename) => {
      if (filename?.endsWith("registry.generated.ts")) return;
      generation = generation.then(generate).catch((error) => {
        console.error("Failed to regenerate modules", error);
        process.exit(1);
      });
    }),
  );
  return {
    close() {
      for (const watcher of watchers) watcher.close();
    },
  };
}
