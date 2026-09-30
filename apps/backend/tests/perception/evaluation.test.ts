import { expect, test } from "bun:test";
import {
  detectRegion,
  evaluationRegions,
  mergeDetections,
} from "../../scripts/perception-evaluation/regions";
import { createTrackingMetrics } from "../../scripts/perception-evaluation/metrics";
import { createPetTracker } from "../../src/perception/tracking/pet-tracker";

const cat = {
  x: 0,
  y: 0,
  w: 2,
  h: 2,
  classId: 1,
  className: "cat" as const,
  confidence: 0.9,
};
test("regional inference reads its own crop and restores original coordinates before merging", async () => {
  const rgb = new Uint8Array(4 * 2 * 3);
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 4; x++) rgb[(y * 4 + x) * 3] = x;
  const detector: Parameters<typeof detectRegion>[0] = {
    async detect(frame) {
      expect(frame.width).toBe(2);
      expect(frame.height).toBe(2);
      expect(Array.from(frame.rgb)).toEqual([
        2, 0, 0, 3, 0, 0, 2, 0, 0, 3, 0, 0,
      ]);
      return {
        detections: [cat],
        timing: { preprocessMs: 0, inferenceMs: 0, postprocessMs: 0 },
      };
    },
  };
  const result = await detectRegion(
    detector,
    { width: 4, height: 2, rgb },
    evaluationRegions(4, 2).edges[1]!,
  );
  expect(result[0]).toMatchObject({ x: 2, y: 0, w: 2, h: 2 });
  const merged = mergeDetections([
    { ...result[0]!, confidence: 0.6 },
    result[0]!,
    { ...result[0]!, classId: 2, className: "dog" },
  ]);
  expect(merged).toHaveLength(2);
  expect(merged[0]?.confidence).toBe(0.9);
});

test("evaluation counts measured coverage separately from predictions, species errors and unacquired episodes", () => {
  const tracker = createPetTracker();
  const metrics = createTrackingMetrics("cat");
  metrics.observe(0, cat, tracker.update(0, [cat]));
  metrics.observe(
    300,
    cat,
    tracker.update(300, [{ ...cat, className: "dog", classId: 2 }]),
  );
  metrics.observe(600, cat, tracker.update(600, []));
  metrics.observe(900, null, tracker.update(900, []));
  metrics.observe(1200, cat, tracker.update(1200, []));
  expect(metrics.result()).toMatchObject({
    frames: 5,
    visible: 4,
    matched: 1,
    missed: 3,
    wrongSpeciesAtTarget: 1,
    unmatchedMeasuredBoxes: 1,
    visibleEpisodes: 2,
    acquiredEpisodes: 1,
    unacquiredEpisodes: 1,
    acquisitionDelaysMs: [0],
    matchRatio: 0.25,
  });
});
