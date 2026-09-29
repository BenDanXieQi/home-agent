import sharp from "sharp";
import type { createDetector } from "../../src/perception/detection/detector";
import { iou } from "../../src/perception/tracking/assignment";

// Deterministic proposals use only image dimensions, never annotation boxes.
export function evaluationRegions(width: number, height: number) {
  const side = Math.min(width, height);
  return {
    center: {
      left: Math.floor((width - side) / 2),
      top: Math.floor((height - side) / 2),
      width: side,
      height: side,
    },
    edges: [
      { left: 0, top: 0, width: side, height: side },
      { left: width - side, top: height - side, width: side, height: side },
    ],
  };
}

export function mergeDetections(
  detections: Awaited<
    ReturnType<Awaited<ReturnType<typeof createDetector>>["detect"]>
  >["detections"],
) {
  const kept: typeof detections = [];
  for (const box of detections.toSorted(
    (a, b) => b.confidence - a.confidence,
  )) {
    if (
      !kept.some(
        (previous) =>
          previous.className === box.className && iou(previous, box) >= 0.7,
      )
    )
      kept.push(box);
  }
  return kept;
}

export async function detectRegion(
  detector: Pick<Awaited<ReturnType<typeof createDetector>>, "detect">,
  frame: Parameters<typeof detector.detect>[0],
  region: ReturnType<typeof evaluationRegions>["center"],
) {
  const rgb = new Uint8Array(
    await sharp(frame.rgb, {
      raw: { width: frame.width, height: frame.height, channels: 3 },
    })
      .extract(region)
      .raw()
      .toBuffer(),
  );
  const result = await detector.detect({
    width: region.width,
    height: region.height,
    rgb,
  });
  return result.detections.map((box) => ({
    ...box,
    x: box.x + region.left,
    y: box.y + region.top,
  }));
}
