import { computeBudgetSchema } from "./budget";
import { perceptionConfigSchema } from "../config";
import { runSchema } from "../observations";
import { videoEventSchema } from "../video/events";
import { sourceAccessSchema } from "../sources";
import { z } from "zod";
import { inspect } from "node:util";
import { frameSchema } from "../detection/frame";
import { detectionLabels } from "../detection/labels";
import {
  ImageProcessingError,
  imageRequestSchema,
} from "../detection/image-request";

export class ComputeBusyError extends Error {
  readonly code = "busy" as const;
}

// These schemas validate the real parent/child IPC boundary, not just TS types.
export const taskSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("initialize") }),
  z.object({ kind: z.literal("detect"), frame: frameSchema }),
  z.object({
    kind: z.literal("detect_image"),
    image: imageRequestSchema,
  }),
  z.object({ kind: z.literal("close") }),
]);
export const videoStartSchema = z.object({
  run: runSchema,
  access: sourceAccessSchema,
  config: perceptionConfigSchema,
  executable: z.string().min(1),
});
export const commandSchema = z.discriminatedUnion("kind", [
  taskSchema.options[0].extend({ budget: computeBudgetSchema }),
  taskSchema.options[1],
  taskSchema.options[2],
  taskSchema.options[3],
  z.object({ kind: z.literal("video_start"), source: videoStartSchema }),
  z.object({ kind: z.literal("video_stop"), runId: z.uuid() }),
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
      workerThreadIds: z.array(z.int().positive()).min(1),
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
  }),
  z.object({ kind: z.literal("closed") }),
  z.object({ kind: z.literal("video_ack") }),
]);
export const requestSchema = z.object({
  id: z.int().positive(),
  task: commandSchema,
});
const errorSchema = z.object({
  message: z.string().max(4096),
  stack: z.string().max(16_384).optional(),
  code: z.enum(["invalid_image", "busy"]).optional(),
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
    code:
      error instanceof ImageProcessingError || error instanceof ComputeBusyError
        ? error.code
        : undefined,
  };
}

export function restoreError(details: z.infer<typeof errorSchema>) {
  const error =
    details.code === "busy"
      ? new ComputeBusyError(details.message)
      : details.code === "invalid_image"
        ? new ImageProcessingError(details.message)
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
  z.object({ kind: z.literal("video"), payload: videoEventSchema }),
  resultResponseSchema,
  errorSchema.extend({
    kind: z.literal("error"),
    id: z.int().positive(),
  }),
  errorSchema.extend({ kind: z.literal("fatal") }),
]);
