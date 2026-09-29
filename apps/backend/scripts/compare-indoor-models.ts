import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { createDetector } from "../src/perception/detection/detector";
import { detectionModelPath } from "../src/perception/detection/model";
import { frameLimits, frameSchema } from "../src/perception/detection/frame";
import { createPerceptionEnvironment } from "./perception-report";
import { createCocoDetector } from "./perception-evaluation/coco-detector";
import {
  indoorManifestSchema,
  createDetectionMetrics,
} from "./perception-evaluation/detection-metrics";

const { values } = parseArgs({
  options: {
    "model-dir": { type: "string" },
    "data-dir": { type: "string" },
    "output-dir": { type: "string" },
  },
  strict: true,
});
if (!values["model-dir"] || !values["data-dir"] || !values["output-dir"])
  throw new Error(
    "Usage: --model-dir <models> --data-dir <reviewed indoor dataset> --output-dir <results>",
  );
const modelDirectory = resolve(values["model-dir"]),
  dataDirectory = resolve(values["data-dir"]),
  outputDirectory = resolve(values["output-dir"]);
const manifestBytes = await readFile(join(dataDirectory, "manifest.json"));
const manifest = indoorManifestSchema.parse(
  JSON.parse(manifestBytes.toString()),
);
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const models = [
  {
    name: "det_4C",
    path: detectionModelPath,
    create: () => createDetector(0.1),
  },
  ...["yolo11n", "yolo11s"].map((name) => ({
    name,
    path: join(modelDirectory, name + ".onnx"),
    create: () =>
      createCocoDetector(join(modelDirectory, name + ".onnx"), "yolo11"),
  })),
  {
    name: "yolox_tiny",
    path: join(modelDirectory, "yolox_tiny.onnx"),
    create: () =>
      createCocoDetector(join(modelDirectory, "yolox_tiny.onnx"), "yolox"),
  },
];
const thresholds = [0.1, 0.25, 0.5, 0.7];
const environment = await createPerceptionEnvironment();
await mkdir(outputDirectory, { recursive: true });
const reports = [];
for (const model of models) {
  const bytes = await readFile(model.path);
  const detector = await model.create();
  const metrics = thresholds.map((threshold) => ({
    threshold,
    all: createDetectionMetrics(),
    tune: createDetectionMetrics(),
    holdout: createDetectionMetrics(),
  }));
  const records = [];
  const durations: number[] = [],
    cpuDurations: number[] = [];
  let peakRss = process.memoryUsage().rss;
  try {
    for (const [index, item] of manifest.images.entries()) {
      const image = await readFile(
        join(dataDirectory, "images", item.file_name),
      );
      if (sha256(image) !== item.sha256)
        throw new Error(`Image fingerprint mismatch: ${item.file_name}`);
      const { data, info } = await sharp(image, {
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
      if (info.width !== item.width || info.height !== item.height)
        throw new Error("Image dimensions differ from annotations");
      if (index === 0) for (let i = 0; i < 3; i++) await detector.detect(frame);
      const started = performance.now(),
        cpu = process.cpuUsage();
      const result = await detector.detect(frame);
      const elapsed = performance.now() - started,
        cpuTime = process.cpuUsage(cpu);
      durations.push(elapsed);
      cpuDurations.push((cpuTime.user + cpuTime.system) / 1000);
      for (const entry of metrics) {
        entry.all.observe(item.annotations, result.detections, entry.threshold);
        entry[item.split].observe(
          item.annotations,
          result.detections,
          entry.threshold,
        );
      }
      records.push({
        imageId: item.id,
        split: item.split,
        detections: result.detections,
        timing: result.timing,
        wallMs: elapsed,
      });
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    const scores = metrics.map((m) => ({
      threshold: m.threshold,
      all: m.all.result(),
      tune: m.tune.result(),
      holdout: m.holdout.result(),
    }));
    const selected = scores.toSorted((a, b) => {
      const macro = (s: typeof a) =>
        Object.values(s.tune.classes).reduce((sum, c) => sum + (c.f1 ?? 0), 0) /
        3;
      return macro(b) - macro(a);
    })[0]!;
    const sorted = durations.toSorted((a, b) => a - b);
    const report = {
      name: model.name,
      sha256: sha256(bytes),
      modelBytes: bytes.length,
      metadata: detector.metadata,
      wallMs: {
        mean: durations.reduce((a, b) => a + b, 0) / durations.length,
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
        max: sorted.at(-1)!,
      },
      cpuMsMean: cpuDurations.reduce((a, b) => a + b, 0) / cpuDurations.length,
      processPeakRssMiB: peakRss / 1024 / 1024,
      scores,
      selectedThresholdOnTune: selected.threshold,
    };
    reports.push(report);
    await writeFile(
      join(outputDirectory, model.name + "-detections.json"),
      JSON.stringify(records, null, 2),
    );
    console.log(
      JSON.stringify({
        name: model.name,
        wallMs: report.wallMs,
        fixedThreshold: scores.find((s) => s.threshold === 0.5),
        selectedThresholdOnTune: selected.threshold,
      }),
    );
  } finally {
    await detector.close();
  }
}
await writeFile(
  join(outputDirectory, "results.json"),
  JSON.stringify(
    {
      ...environment,
      manifestSha256: sha256(manifestBytes),
      imageCount: manifest.images.length,
      dataset: {
        source: manifest.source,
        review: manifest.review,
        annotationSha256: manifest.annotationSha256,
      },
      method:
        "Single-thread CPU ORT, model-specific preprocessing, shared same-class NMS IoU 0.7, original-image boxes, greedy one-to-one IoU>=0.5 matching. Person/cat/dog only; no tracking or crops. Decode and warmup excluded from timing. Threshold selection uses tune split only; COCO val images are not unseen household-camera footage. RSS is cumulative within this evaluation process, not isolated per-model memory.",
      reports,
    },
    null,
    2,
  ),
);
