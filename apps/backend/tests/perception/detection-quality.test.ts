import { expect, test } from "bun:test";
import { join } from "node:path";
import sharp from "sharp";
import {
  createDetectionMetrics,
  indoorManifestSchema,
} from "../../scripts/perception-evaluation/detection-metrics";
import { createDetectionPool } from "../../src/perception/compute/pool";
import { iou } from "../../src/perception/tracking/assignment";

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

test.skipIf(!dataDirectory)(
  "rejects a furniture edge false positive while retaining a clipped person on real images",
  async () => {
    const manifest = indoorManifestSchema.parse(
      await Bun.file(
        new URL("./fixtures/indoor-manifest.json", import.meta.url),
      ).json(),
    );
    const samples = [
      {
        id: 27982,
        crop: { left: 0, top: 0, width: 500, height: 283 },
        human: null,
      },
      {
        id: 494913,
        crop: { left: 0, top: 258, width: 640, height: 170 },
        human: { x: 522, y: 0, w: 105, h: 80 },
      },
    ];
    const pool = await createDetectionPool();
    try {
      for (const sample of samples) {
        const image = manifest.images.find((entry) => entry.id === sample.id)!;
        const input = await Bun.file(
          join(dataDirectory!, "images", image.file_name),
        ).bytes();
        expect(new Bun.CryptoHasher("sha256").update(input).digest("hex")).toBe(
          image.sha256,
        );
        const { data, info } = await sharp(input)
          .extract(sample.crop)
          .removeAlpha()
          .toColourspace("srgb")
          .raw()
          .toBuffer({ resolveWithObject: true });
        const result = await pool.detect({
          width: info.width,
          height: info.height,
          rgb: new Uint8Array(data),
        });
        const humans = result.detections.filter(
          (box) => box.className === "human",
        );
        expect(humans).toHaveLength(sample.human ? 1 : 0);
        if (sample.human)
          expect(iou(humans[0]!, sample.human)).toBeGreaterThanOrEqual(0.5);
      }
    } finally {
      await pool.close();
    }
  },
  30000,
);
