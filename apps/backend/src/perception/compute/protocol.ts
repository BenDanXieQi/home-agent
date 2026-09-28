import { z } from "zod";
import { inspect } from "node:util";
import { frameSchema } from "../detection/frame";
import { detectionLabels } from "../detection/labels";
import {
  ImageProcessingError,
  imageRequestSchema,
} from "../detection/image-request";

// These schemas validate the real parent/child IPC boundary, not just TS types.
export const taskSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("initialize"), modelPath: z.string().min(1) }),
  z.object({ kind: z.literal("detect"), frame: frameSchema }),
  z.object({
    kind: z.literal("detect_image"),
    image: imageRequestSchema,
    stagingPath: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal("close") }),
]);
const tensorMetadata = z.object({
  name: z.string(),
  isTensor: z.literal(true),
  type: z.literal("float32"),
  shape: z.array(z.union([z.number(), z.string()])),
});
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const detectionResultSchema = z.object({
  detections: z.array(
    z.object({
      x: z.int().nonnegative(),
      y: z.int().nonnegative(),
      w: z.int().positive(),
      h: z.int().positive(),
      confidence: z.number().min(0).max(1),
      classId: z.int().min(0).max(4),
      className: z.enum(detectionLabels),
    }),
  ),
  timing: z.object({
    readMs: z.number().nonnegative(),
    decodeMs: z.number().nonnegative(),
    annotationMs: z.number().nonnegative(),
    preprocessMs: z.number().nonnegative(),
    inferenceMs: z.number().nonnegative(),
    postprocessMs: z.number().nonnegative(),
    queueMs: z.number().nonnegative(),
    workerDispatchMs: z.number().nonnegative(),
  }),
});
export const resultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("initialized"),
    metadata: z.object({
      input: tensorMetadata,
      output: tensorMetadata,
      provider: z.literal("cpu"),
      sharpConcurrency: z.int().positive(),
      workerThreadId: z.int().positive(),
      intraOpNumThreads: z.int().positive(),
      modelPath: z.string().min(1),
      sha256: sha256Schema,
    }),
  }),
  detectionResultSchema.extend({ kind: z.literal("detected") }),
  detectionResultSchema.extend({
    kind: z.literal("image_detected"),
    imagePath: z.string().min(1),
    inputSha256: sha256Schema,
    width: z.int().positive(),
    height: z.int().positive(),
    stagedImage: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal("closed") }),
]);
export const requestSchema = z.object({
  id: z.int().positive(),
  task: taskSchema,
});
const errorSchema = z.object({
  message: z.string().max(4096),
  stack: z.string().max(16_384).optional(),
  code: z.enum(["invalid_image", "output_failed"]).optional(),
});

export function errorDetails(error: unknown) {
  const messages = [];
  const seen = new Set<unknown>();
  let cause = error;
  while (cause !== undefined && messages.length < 4 && !seen.has(cause)) {
    seen.add(cause);
    messages.push(
      cause instanceof Error
        ? cause.message
        : inspect(cause, {
            depth: 1,
            maxArrayLength: 10,
            maxStringLength: 1024,
          }),
    );
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return {
    message: messages.join(": ").slice(0, 4096),
    stack: error instanceof Error ? error.stack?.slice(0, 16_384) : undefined,
    code: error instanceof ImageProcessingError ? error.code : undefined,
  };
}

export function restoreError(details: z.infer<typeof errorSchema>) {
  const error = details.code
    ? new ImageProcessingError(details.code, details.message)
    : new Error(details.message);
  if (details.stack) error.stack = details.stack;
  return error;
}

export const resultResponseSchema = z.object({
  kind: z.literal("result"),
  id: z.int().positive(),
  result: resultSchema,
  processingMs: z.number().nonnegative(),
});

export const responseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }),
  resultResponseSchema,
  errorSchema.extend({
    kind: z.literal("error"),
    id: z.int().positive(),
  }),
  errorSchema.extend({ kind: z.literal("fatal") }),
]);
