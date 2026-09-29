import { cpuRatioSchema } from "./compute/budget";
import { z } from "zod";

export const sourceSelectionSchema = z.strictObject({
  deviceId: z.string().regex(/^[0-9]{1,32}$/),
  channel: z.union([z.literal(1), z.literal(2)]),
});
export const perceptionConfigSchema = z
  .strictObject({
    cpuRatio: cpuRatioSchema,
    sources: z
      .union([z.literal("household"), z.array(sourceSelectionSchema).max(8)])
      .default([]),
    sampleFps: z.number().positive().max(30).default(3),
    firstFrameTimeoutMs: z.int().min(100).max(300_000).default(90_000),
    silenceTimeoutMs: z.int().min(100).max(300_000).default(30_000),
    maxFrameAgeMs: z.int().min(100).max(30_000).default(2_000),
  })
  .refine(
    (config) => config.silenceTimeoutMs > 1000 / config.sampleFps,
    "Silence timeout must exceed the sampling interval",
  )
  .refine(
    (config) =>
      config.sources === "household" ||
      new Set(config.sources.map(sourceKey)).size === config.sources.length,
    "Duplicate camera channel",
  );
export function sourceKey(source: z.infer<typeof sourceSelectionSchema>) {
  return `${source.deviceId}:${source.channel}`;
}
