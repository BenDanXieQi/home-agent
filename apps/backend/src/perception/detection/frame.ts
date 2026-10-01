import { z } from "zod";
import { frameLimits } from "@home-agent/api/contracts";
export { frameLimits };

// Shared boundary; importing it never loads the native inference runtime.
export const frameSchema = z
  .object({
    width: z.int().positive().max(frameLimits.maxDimension),
    height: z.int().positive().max(frameLimits.maxDimension),
    rgb: z.instanceof(Uint8Array),
  })
  .refine(({ width, height }) => width * height <= frameLimits.maxPixels, {
    message: "Frame exceeds the 3840x2160 pixel budget",
  })
  .refine(({ rgb }) => rgb.buffer instanceof ArrayBuffer, {
    message: "Shared pixel buffers are not supported",
  })
  .refine(({ width, height, rgb }) => rgb.length === width * height * 3, {
    message: "Expected packed RGB24 pixels matching width and height",
  });
