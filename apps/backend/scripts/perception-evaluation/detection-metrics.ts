import { z } from "zod";
import type { detectionSchema } from "../../src/perception/observations";
import { iou } from "../../src/perception/tracking/assignment";

export const indoorManifestSchema = z.object({
  source: z.string(),
  annotationSha256: z.string(),
  review: z.string(),
  images: z
    .array(
      z.object({
        id: z.int().positive(),
        file_name: z.string().regex(/^\d{12}\.jpg$/),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        width: z.int().positive(),
        height: z.int().positive(),
        group: z.string(),
        split: z.enum(["tune", "holdout"]),
        source: z.url(),
        annotations: z.array(
          z.object({
            className: z.enum(["human", "cat", "dog"]),
            bbox: z.tuple([
              z.number(),
              z.number(),
              z.number().positive(),
              z.number().positive(),
            ]),
            iscrowd: z.literal(0),
          }),
        ),
      }),
    )
    .min(1),
});
const labels = ["human", "cat", "dog"] as const;
const counts = () => ({ tp: 0, fp: 0, fn: 0 });
export function createDetectionMetrics() {
  const classes = { human: counts(), cat: counts(), dog: counts() };
  let images = 0,
    negativeImages = 0,
    negativeWithPredictions = 0;
  return {
    observe(
      annotations: z.infer<
        typeof indoorManifestSchema
      >["images"][number]["annotations"],
      detections: z.infer<typeof detectionSchema>[],
      threshold: number,
    ) {
      images++;
      if (!annotations.length) {
        negativeImages++;
        if (
          detections.some(
            (d) =>
              d.confidence >= threshold &&
              (d.className === "human" ||
                d.className === "cat" ||
                d.className === "dog"),
          )
        )
          negativeWithPredictions++;
      }
      for (const label of labels) {
        const truth = annotations
          .filter((a) => a.className === label)
          .map(({ bbox }) => ({
            x: bbox[0],
            y: bbox[1],
            w: bbox[2],
            h: bbox[3],
          }));
        const used = new Set<number>();
        for (const box of detections
          .filter((d) => d.className === label && d.confidence >= threshold)
          .toSorted((a, b) => b.confidence - a.confidence)) {
          let best = -1,
            overlap = 0.5;
          truth.forEach((target, i) => {
            const score = iou(target, box);
            if (!used.has(i) && score >= overlap) {
              best = i;
              overlap = score;
            }
          });
          if (best < 0) classes[label].fp++;
          else {
            used.add(best);
            classes[label].tp++;
          }
        }
        classes[label].fn += truth.length - used.size;
      }
    },
    result() {
      return {
        images,
        negativeImages,
        negativeWithPredictions,
        classes: Object.fromEntries(
          labels.map((label) => {
            const { tp, fp, fn } = classes[label];
            return [
              label,
              {
                tp,
                fp,
                fn,
                precision: tp + fp ? tp / (tp + fp) : null,
                recall: tp + fn ? tp / (tp + fn) : null,
                f1: 2 * tp + fp + fn ? (2 * tp) / (2 * tp + fp + fn) : null,
              },
            ];
          }),
        ),
      };
    },
  };
}
