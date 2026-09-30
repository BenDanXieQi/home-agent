import { expect, test } from "bun:test";
import {
  prepareCocoInput,
  decodeCocoOutput,
} from "../../scripts/perception-evaluation/coco-detector";
import { createDetectionMetrics } from "../../scripts/perception-evaluation/detection-metrics";

test("candidate preprocessing distinguishes YOLOX raw BGR corner padding from YOLO11 normalized RGB center padding", async () => {
  const rgb = new Uint8Array(
    Array.from({ length: 8 }, () => [10, 20, 30]).flat(),
  );
  const frame = { width: 4, height: 2, rgb };
  const x = await prepareCocoInput(frame, 32, "yolox");
  expect(x.mapping).toMatchObject({ scale: 8, padX: 0, padY: 0 });
  expect(x.data[0]).toBe(30);
  expect(x.data[2 * 32 * 32]).toBe(10);
  expect(x.data[20 * 32]).toBe(114);
  const y = await prepareCocoInput(frame, 32, "yolo11");
  expect(y.mapping).toMatchObject({ scale: 8, padX: 0, padY: 8 });
  expect(y.data[0]).toBeCloseTo(114 / 255);
  expect(y.data[8 * 32]).toBeCloseTo(10 / 255);
  expect(y.data[2 * 32 * 32 + 8 * 32]).toBeCloseTo(30 / 255);
  const halfPixel = await prepareCocoInput(
    { width: 5, height: 64, rgb: new Uint8Array(5 * 64 * 3) },
    32,
    "yolo11",
  );
  expect(halfPixel.mapping.padX).toBe(15);
});

test("YOLOX decodes grid offsets and objectness while YOLO11 decodes transposed class scores", () => {
  const mapping = {
    width: 64,
    height: 32,
    scale: 0.5,
    padX: 0,
    padY: 0,
    side: 32,
  };
  const rawX = new Float32Array(21 * 85);
  rawX.set([1, 1, 0, 0, 0.8], 0);
  rawX[5 + 15] = 0.9;
  const x = decodeCocoOutput(rawX, 21, "yolox", mapping);
  expect(x).toHaveLength(1);
  expect(x[0]).toMatchObject({
    className: "cat",
    classId: 1,
    x: 8,
    y: 8,
    w: 16,
    h: 16,
  });
  expect(x[0]!.confidence).toBeCloseTo(0.72);
  const rawY = new Float32Array(84);
  rawY.set([16, 16, 8, 8]);
  rawY[4 + 16] = 0.9;
  expect(
    decodeCocoOutput(rawY, 1, "yolo11", { ...mapping, padY: 8 })[0],
  ).toMatchObject({ className: "dog", classId: 2, x: 24, y: 8, w: 16, h: 16 });
  rawY[4 + 2] = 0.95;
  expect(decodeCocoOutput(rawY, 1, "yolo11", mapping)).toEqual([]);
});

test("indoor metrics penalize duplicates and species swaps and count empty-room false positives", () => {
  const metric = createDetectionMetrics();
  const box = {
    x: 10,
    y: 10,
    w: 20,
    h: 20,
    className: "cat" as const,
    classId: 1,
    confidence: 0.9,
  };
  metric.observe(
    [{ className: "cat", bbox: [10, 10, 20, 20], iscrowd: 0 }],
    [box, box],
    0.5,
  );
  metric.observe(
    [{ className: "cat", bbox: [10, 10, 20, 20], iscrowd: 0 }],
    [{ ...box, className: "dog", classId: 2 }],
    0.5,
  );
  metric.observe([], [box], 0.5);
  expect(metric.result()).toMatchObject({
    negativeImages: 1,
    negativeWithPredictions: 1,
    classes: { cat: { tp: 1, fp: 2, fn: 1 }, dog: { tp: 0, fp: 1, fn: 0 } },
  });
});
