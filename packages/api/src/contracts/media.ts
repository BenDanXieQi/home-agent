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
