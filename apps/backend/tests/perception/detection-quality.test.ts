import { expect, test } from "bun:test";
import { createDetectionPool } from "../../src/perception/compute/pool";

const imagePath = process.env.PERCEPTION_BUS_IMAGE_PATH;

test.skipIf(!imagePath)(
  "detects both fully visible people in the street image before and after resizing",
  async () => {
    // Manually marked on the 810 × 1080 source image, not copied from model output.
    // Partially visible people at the image edges are not required detections.
    const people = [
      { x: 45, y: 395, w: 205, h: 515 },
      { x: 215, y: 400, w: 135, h: 465 },
    ];
    const pool = await createDetectionPool();
    try {
      for (const resize of [undefined, { width: 405, height: 540 }]) {
        const result = await pool.detectImage({ path: imagePath!, resize });
        // This expectation belongs to one specific fixture, not any file named bus.jpg.
        expect(result.inputSha256).toBe(
          "c02019c4979c191eb739ddd944445ef408dad5679acab6fd520ef9d434bfbc63",
        );
        expect([result.width, result.height]).toEqual(
          resize ? [405, 540] : [810, 1080],
        );
        const humans = result.detections.filter(
          (box) => box.className === "human",
        );
        const matched = new Set<number>();
        for (const person of people) {
          const index = humans.findIndex((box, candidate) => {
            if (matched.has(candidate)) return false;
            // Compare in source coordinates so resizing must preserve localization.
            const x = (box.x * 810) / result.width;
            const y = (box.y * 1080) / result.height;
            const w = (box.w * 810) / result.width;
            const h = (box.h * 1080) / result.height;
            const intersection =
              Math.max(
                0,
                Math.min(x + w, person.x + person.w) - Math.max(x, person.x),
              ) *
              Math.max(
                0,
                Math.min(y + h, person.y + person.h) - Math.max(y, person.y),
              );
            // IoU (intersection over union) tolerates box drift but rejects missing,
            // shifted or whole-image boxes. Confidence and total count are not pinned.
            return (
              intersection / (w * h + person.w * person.h - intersection) >= 0.5
            );
          });
          expect(index).toBeGreaterThanOrEqual(0);
          matched.add(index);
        }
      }
    } finally {
      await pool.close();
    }
  },
  30000,
);
