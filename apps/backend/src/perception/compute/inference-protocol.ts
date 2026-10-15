import { z } from "zod";

export function inferenceRequest<Input extends z.ZodType>(input: Input) {
  return z.object({ requestId: z.uuid(), input });
}
export const inferenceResponseSchema = z.object({
  requestId: z.uuid().nullable(),
  message: z.unknown(),
});
