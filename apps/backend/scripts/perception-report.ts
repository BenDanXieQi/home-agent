import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, availableParallelism, cpus, platform, release } from "node:os";
import { z } from "zod";
import { detectionComputeBudget } from "../src/perception/compute/budget";
import type { createDetectionPool } from "../src/perception/compute/pool";
import { frameLimits } from "../src/perception/detection/frame";
import { imageLimits } from "../src/perception/detection/image-request";

const require = createRequire(import.meta.url);
const packageMetadata = z.object({ version: z.string().min(1) });

async function dependencyVersion(name: string) {
  // Read package metadata without importing the native inference runtime here.
  const source = await readFile(
    require.resolve(`${name}/package.json`),
    "utf8",
  );
  return packageMetadata.parse(JSON.parse(source)).version;
}

export async function createPerceptionReport(
  metadata: Awaited<ReturnType<typeof createDetectionPool>>["metadata"],
) {
  const [ort, piscina, sharp] = await Promise.all([
    dependencyVersion("onnxruntime-node"),
    dependencyVersion("piscina"),
    dependencyVersion("sharp"),
  ]);
  return {
    metadata,
    environment: {
      runtime: process.version,
      bun: Bun.version,
      platform: platform(),
      osRelease: release(),
      arch: arch(),
      cpus: availableParallelism(),
      cpuModel: cpus()[0]?.model ?? null,
    },
    dependencies: { "onnxruntime-node": ort, piscina, sharp },
    computeBudget: { ...detectionComputeBudget },
    frameLimits: { ...frameLimits },
    imageLimits: { ...imageLimits },
  };
}
