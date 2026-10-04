import { z } from "zod";

export const pcmSchema = z
  .instanceof(Int16Array)
  .refine((pcm) => pcm.byteLength > 0 && pcm.byteLength <= 4096);
