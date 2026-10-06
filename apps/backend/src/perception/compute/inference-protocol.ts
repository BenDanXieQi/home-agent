import { z } from "zod";

// Transport identity is independent of a frame, segment, or model result kind.
export function inferenceRequest<Input extends z.ZodType>(input: Input) {
  return z.object({ requestId: z.uuid(), input });
}
export const inferenceResponseSchema = z.object({
  requestId: z.uuid().nullable(),
  message: z.unknown(),
});
