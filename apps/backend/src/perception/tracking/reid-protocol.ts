import { z } from "zod";
import { frameSchema } from "../detection/frame";
import { detectionSchema } from "../observations";
export const reidRequestSchema = z.object({
  frame: frameSchema,
  boxes: z.array(detectionSchema).max(8),
});
export const reidResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }),
  z.object({
    kind: z.literal("features"),
    features: z.array(z.array(z.number()).length(128)).max(8),
  }),
  z.object({ kind: z.literal("failed"), error: z.string().max(4096) }),
]);
