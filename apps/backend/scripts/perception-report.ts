import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, availableParallelism, cpus, platform, release } from "node:os";
import { z } from "zod";
import {
  detectionComputeBudget,
  type computeBudgetSchema,
} from "../src/perception/compute/budget";
import type { createDetectionPool } from "../src/perception/compute/pool";
import { frameLimits } from "../src/perception/detection/frame";
import { imageLimits } from "../src/perception/detection/image-request";

const require = createRequire(import.meta.url);
const packageMetadata = z.object({ version: z.string().min(1) });

export async function readDependencyVersion(path: string | URL) {
  // Read package metadata without importing the native inference runtime here.
  const source = await readFile(path, "utf8");
  return packageMetadata.parse(JSON.parse(source)).version;
}

export async function createPerceptionEnvironment() {
  const [ort, piscina, sharp] = await Promise.all([
    readDependencyVersion(require.resolve("onnxruntime-node/package.json")),
    readDependencyVersion(require.resolve("piscina/package.json")),
    readDependencyVersion(require.resolve("sharp/package.json")),
  ]);
  return {
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
  };
}

export async function createPerceptionReport(
  metadata: Awaited<ReturnType<typeof createDetectionPool>>["metadata"],
  budget: z.infer<typeof computeBudgetSchema>,
) {
  return {
    metadata,
    ...(await createPerceptionEnvironment()),
    computeBudget: {
      ...detectionComputeBudget,
      ...budget,
    },
    frameLimits: { ...frameLimits },
    imageLimits: { ...imageLimits },
  };
}
