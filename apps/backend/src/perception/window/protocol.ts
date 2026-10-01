import { z } from "zod";
import { windowFrameSchema } from "@home-agent/api/contracts";
import { runSchema } from "../observations";
import { windowLimits } from "./limits";

export const sampledFrameSchema = windowFrameSchema
  .omit({ detections: true, tracks: true })
  .extend({
    rgb: z
      .instanceof(Uint8Array)
      .refine(
        (bytes) =>
          bytes.byteLength <=
          windowLimits.shortSide * windowLimits.longSide * 3,
      ),
    gray: z
      .instanceof(Uint8Array)
      .refine((bytes) => bytes.byteLength === windowLimits.graySide ** 2),
  })
  .refine(
    (frame) =>
      frame.rgb.byteLength === frame.retainedWidth * frame.retainedHeight * 3,
  );
export const windowFrameEventSchema = z.object({
  event: z.literal("window_frame"),
  run: runSchema,
  frame: sampledFrameSchema,
  skipped: z.int().nonnegative(),
});
export const windowAcknowledgementSchema = z.object({
  kind: z.literal("window_ack"),
  runId: z.uuid(),
  sequence: z.int().positive(),
});

export const windowGapEventSchema = z.object({
  event: z.literal("window_gap"),
  run: runSchema,
  at: z.number(),
  reason: z.enum(["capture_failed", "capture_capacity"]),
});
