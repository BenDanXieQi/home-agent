import { z } from "zod";
import { resolve } from "node:path";
import { frameLimits } from "./frame";

export const imageLimits = {
  maxFileBytes: 32 * 1024 * 1024,
} as const;

const imagePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .transform((path) => resolve(path))
  .pipe(z.string().max(4096));

export const imageRequestSchema = z.strictObject({
  path: imagePathSchema,
  resize: z
    .object({
      width: z.int().positive().max(frameLimits.maxDimension),
      height: z.int().positive().max(frameLimits.maxDimension),
    })
    .refine(({ width, height }) => width * height <= frameLimits.maxPixels, {
      message: "Resized image exceeds the 3840x2160 pixel budget",
    })
    .optional(),
});

export class ImageProcessingError extends Error {
  override name = "ImageProcessingError";
  readonly code = "invalid_image" as const;
}
