import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import sharp from "sharp";
import { createPerceptionEnvironment } from "./perception-report";
import { createDetector } from "../src/perception/detection/detector";
import { detectionModelPath } from "../src/perception/detection/model";
import { frameLimits, frameSchema } from "../src/perception/detection/frame";
import {
  createPetTracker,
  petTrackingPolicySchema,
} from "../src/perception/tracking/pet-tracker";
import {
  evaluationRegions,
  detectRegion,
  mergeDetections,
} from "./perception-evaluation/regions";
import { createTrackingMetrics } from "./perception-evaluation/metrics";

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    "output-dir": { type: "string" },
  },
  strict: true,
});
if (!values["data-dir"] || !values["output-dir"])
  throw new Error(
    "Usage: bun scripts/evaluate-pet-tracking.ts --data-dir <VOT fixtures> --output-dir <report directory>",
  );
const dataDirectory = resolve(values["data-dir"]);
const outputDirectory = resolve(values["output-dir"]);
const manifestSchema = z.object({
  source: z.string(),
  samplingFps: z.number().positive(),
  frames: z
    .array(
      z.object({
        frame: z.int().positive(),
        timeMs: z.number().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(2),
});
const modes = ["full", "center", "edges"] as const;
const policies = [0.5, 0.1, 0.2, 0.3].flatMap((continuationConfidence) =>
  [0.5, 0.6, 0.7].flatMap((newTrackConfidence) =>
    [1, 2, 3].map((confirmationHits) =>
      petTrackingPolicySchema.parse({
        continuationConfidence,
        newTrackConfidence,
        confirmationHits,
      }),
    ),
  ),
);
const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
async function measure<T>(work: () => Promise<T>) {
  const started = performance.now(),
    cpu = process.cpuUsage();
  const value = await work();
  const elapsedCpu = process.cpuUsage(cpu);
  return {
    value,
    wallMs: performance.now() - started,
    cpuMs: (elapsedCpu.user + elapsedCpu.system) / 1000,
  };
}
function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    mean: samples.reduce((sum, v) => sum + v, 0) / samples.length,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    max: sorted.at(-1)!,
  };
}
await mkdir(outputDirectory, { recursive: true });
const environment = await createPerceptionEnvironment();
const modelSha256 = sha256(await readFile(detectionModelPath));
const detector = await createDetector(0.1);
const summaries = [];
try {
  for (const { name, className } of [
    { name: "cat1", className: "cat" as const },
    { name: "dog", className: "dog" as const },
  ]) {
    const directory = join(dataDirectory, name);
    const manifestBytes = await readFile(
      join(directory, "manifest.json"),
      "utf8",
    );
    const manifest = manifestSchema.parse(JSON.parse(manifestBytes));
    const labels = await readFile(join(directory, "groundtruth.txt"), "utf8");
    const truth = labels
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const box = line.split(",").map(Number);
        if (box.length !== 4)
          throw new Error("Expected four VOT rectangle coordinates");
        return box;
      });
    const variants = modes.flatMap((mode) =>
      policies.map((policy) => ({
        mode,
        policy,
        tracker: createPetTracker(undefined, policy),
        all: createTrackingMetrics(className),
        tune: createTrackingMetrics(className),
        holdout: createTrackingMetrics(className),
        trackingMs: [] as number[],
      })),
    );
    const timing = new Map(
      modes.map((mode) => [
        mode,
        { wallMs: [] as number[], cpuMs: [] as number[] },
      ]),
    );
    const records = [];
    let previousTime = -Infinity;
    let peakRss = process.memoryUsage().rss;
    for (const [index, item] of manifest.frames.entries()) {
      if (item.timeMs <= previousTime)
        throw new Error("Fixture times must strictly increase");
      previousTime = item.timeMs;
      const bytes = await readFile(
        join(directory, String(item.frame).padStart(8, "0") + ".jpg"),
      );
      if (sha256(bytes) !== item.sha256)
        throw new Error(`Image fingerprint mismatch: ${name}/${item.frame}`);
      const { data, info } = await sharp(bytes, {
        limitInputPixels: frameLimits.maxPixels,
      })
        .removeAlpha()
        .toColourspace("srgb")
        .raw()
        .toBuffer({ resolveWithObject: true });
      const frame = frameSchema.parse({
        width: info.width,
        height: info.height,
        rgb: new Uint8Array(data),
      });
      const regions = evaluationRegions(frame.width, frame.height);
      const full = await measure(
        async () => (await detector.detect(frame)).detections,
      );
      const center = await measure(async () =>
        mergeDetections([
          ...full.value,
          ...(await detectRegion(detector, frame, regions.center)),
        ]),
      );
      const edges = await measure(async () => {
        const boxes = [...full.value];
        for (const region of regions.edges)
          boxes.push(...(await detectRegion(detector, frame, region)));
        return mergeDetections(boxes);
      });
      const observations = {
        full: full.value,
        center: center.value,
        edges: edges.value,
      };
      const gt = truth[item.frame - 1];
      if (!gt) throw new Error("Annotation missing for sampled frame");
      const target =
        gt.every(Number.isFinite) && gt[2]! > 0 && gt[3]! > 0
          ? { x: gt[0]!, y: gt[1]!, w: gt[2]!, h: gt[3]! }
          : null;
      for (const variant of variants) {
        const started = performance.now();
        const tracks = variant.tracker.update(
          item.timeMs,
          observations[variant.mode],
        );
        variant.trackingMs.push(performance.now() - started);
        variant.all.observe(item.timeMs, target, tracks);
        (index < Math.floor(manifest.frames.length / 2)
          ? variant.tune
          : variant.holdout
        ).observe(item.timeMs, target, tracks);
      }
      if (index >= 3) {
        for (const [mode, value] of [
          ["full", full],
          ["center", center],
          ["edges", edges],
        ] as const) {
          const samples = timing.get(mode)!;
          samples.wallMs.push(
            value.wallMs + (mode === "full" ? 0 : full.wallMs),
          );
          samples.cpuMs.push(value.cpuMs + (mode === "full" ? 0 : full.cpuMs));
        }
      }
      records.push({
        ...item,
        width: frame.width,
        height: frame.height,
        target,
        regions,
        detections: observations,
      });
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      if ((index + 1) % 50 === 0)
        console.log(`${name}: ${index + 1}/${manifest.frames.length} frames`);
    }
    const summary = {
      name,
      className,
      source: manifest.source,
      samplingFps: manifest.samplingFps,
      manifestSha256: sha256(manifestBytes),
      annotationsSha256: sha256(labels),
      modelSha256,
      frames: manifest.frames.length,
      peakRssMiB: peakRss / 1024 / 1024,
      timings: Object.fromEntries(
        [...timing].map(([mode, samples]) => [
          mode,
          {
            wallMs: distribution(samples.wallMs),
            cpuMs: distribution(samples.cpuMs),
          },
        ]),
      ),
      variants: variants.map((v) => ({
        mode: v.mode,
        policy: v.policy,
        all: v.all.result(),
        tune: v.tune.result(),
        holdout: v.holdout.result(),
        trackingMs: distribution(v.trackingMs),
      })),
    };
    summaries.push(summary);
    await writeFile(
      join(outputDirectory, name + "-candidates.json"),
      JSON.stringify(records),
    );
    await writeFile(
      join(outputDirectory, name + "-results.json"),
      JSON.stringify(summary, null, 2),
    );
    console.log(`${name}: completed ${variants.length} variants`);
  }
} finally {
  await detector.close();
}
await writeFile(
  join(outputDirectory, "results.json"),
  JSON.stringify(
    {
      ...environment,
      semantics: {
        split:
          "First half tunes parameters; second half is a temporal holdout, not an independent camera or scene.",
        match:
          "One target per visible frame at IoU >= 0.5; measured boxes only.",
        unmatched:
          "Unmatched and absent-frame boxes are diagnostic counts, not false positives: other objects are unannotated.",
        timing:
          "One CPU detector session, sequential regions; excludes JPEG decode; three warmup frames excluded. Full-frame inference is shared between experimental variants.",
        sampling:
          "Only the fixture sampling rate is evaluated; missing input frames are never synthesized.",
      },
      summaries,
    },
    null,
    2,
  ),
);
