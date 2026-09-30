import { z } from "zod";

export const videoMetricsSchema = z.object({
  elapsedMs: z.number(),
  ageSamples: z.number(),
  complete: z.number(),
  sampled: z.number(),
  replaced: z.number(),
  expired: z.number(),
  discarded: z.number(),
  submitted: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  inFlight: z.number(),
  pending: z.number(),
  ageP50Ms: z.number(),
  ageP95Ms: z.number(),
  ageMaxMs: z.number(),
  schedulingWaitMaxMs: z.number(),
});
export function createVideoMetrics() {
  const values = videoMetricsSchema.parse(
    Object.fromEntries(
      Object.keys(videoMetricsSchema.shape).map((key) => [key, 0]),
    ),
  );
  const startedAt = performance.now();
  const ages: number[] = [];
  let cursor = 0;
  return {
    values,
    age(age: number) {
      ages[cursor++ % 512] = age;
      values.ageSamples++;
      values.ageMaxMs = Math.max(values.ageMaxMs, age);
    },
    snapshot() {
      const sorted = ages.toSorted((a, b) => a - b);
      return {
        ...values,
        elapsedMs: performance.now() - startedAt,
        ageP50Ms: sorted[Math.floor((sorted.length - 1) * 0.5)] ?? 0,
        ageP95Ms: sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 0,
      };
    },
  };
}
