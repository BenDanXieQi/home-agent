import { dirname, resolve } from "node:path";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { perceptionConfigSchema } from "./config";

export async function readPerceptionConfigFile(path: string) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return {};
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65_536)
      throw new Error(
        "Perception configuration must be a regular file of at most 64 KiB",
      );
    const buffer = Buffer.alloc(65_537);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65_536)
      throw new Error("Perception configuration exceeds 64 KiB");
    const config: unknown = JSON.parse(buffer.toString("utf8", 0, bytesRead));
    return config;
  } finally {
    await file.close();
  }
}

export async function readPerceptionConfig(path: string) {
  const config = perceptionConfigSchema.parse(
    await readPerceptionConfigFile(path),
  );
  if (config.identity)
    config.identity.modelDirectory = resolve(
      dirname(path),
      config.identity.modelDirectory,
    );
  return config;
}
