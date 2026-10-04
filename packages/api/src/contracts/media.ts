import { z } from "zod";

export const sourceMediaSchema = z.object({
  generation: z.uuid(),
  clockRate: z.literal(90000),
});
export const mediaFrameTimeSchema = z
  .object({
    generation: z.uuid(),
    pts: z.int().min(0).max(0xffffffff),
    rtpTimestamp: z.int().min(0).max(0xffffffff),
    timeBaseNumerator: z.literal(1),
    timeBaseDenominator: z.literal(90000),
    quality: z.literal("source_media"),
  })
  .refine((time) => time.pts === time.rtpTimestamp, {
    message: "PTS must preserve the source RTP timestamp",
  });

// The digest covers the complete packed RGB24 frame at its decoded dimensions.
// Resized, cropped, encoded, or approximate image hashes are different evidence.
export const frameFingerprintSchema = z.object({
  algorithm: z.literal("md5_rgb24"),
  value: z.string().regex(/^[a-f0-9]{32}$/),
  width: z.int().positive(),
  height: z.int().positive(),
});

// Xiaomi's camera SDK defines LOW=1 and HIGH=3. Profile 2 is also accepted;
// no profile number asserts a model-specific resolution.
export const cameraVideoQualitySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
