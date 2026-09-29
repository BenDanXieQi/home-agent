import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  createDetectionMetrics,
  indoorManifestSchema,
} from "../../scripts/perception-evaluation/detection-metrics";
import { createDetectionPool } from "../../src/perception/compute/pool";

const dataDirectory = process.env.PERCEPTION_INDOOR_DATA_DIR;

test.skipIf(!dataDirectory)(
  "preserves human, cat and dog detection quality on the fixed indoor set",
  async () => {
    const manifest = indoorManifestSchema.parse(
      await Bun.file(
        new URL("./fixtures/indoor-manifest.json", import.meta.url),
      ).json(),
    );
    const metrics = createDetectionMetrics();
    const pool = await createDetectionPool();
    try {
      for (const image of manifest.images) {
        const result = await pool.detectImage({
          path: join(dataDirectory!, "images", image.file_name),
        });
        expect(result.inputSha256).toBe(image.sha256);
        expect([result.width, result.height]).toEqual([
          image.width,
          image.height,
        ]);
        metrics.observe(image.annotations, result.detections, 0.5);
      }
    } finally {
      await pool.close();
    }
    const score = metrics.result();
    expect(score.images).toBe(63);
    expect(score.negativeImages).toBe(10);
    expect(score.negativeWithPredictions).toBeLessThanOrEqual(1);
    // Non-regression bounds for the current model, not household acceptance targets.
    // Ground truth comes from COCO annotations; improvements remain permissible.
    for (const [label, minimumMatches, maximumFalsePositives] of [
      ["human", 20, 1],
      ["cat", 22, 0],
      ["dog", 25, 1],
    ] as const) {
      expect(score.classes[label]!.tp).toBeGreaterThanOrEqual(minimumMatches);
      expect(score.classes[label]!.fp).toBeLessThanOrEqual(
        maximumFalsePositives,
      );
    }
  },
  30000,
);
