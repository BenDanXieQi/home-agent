import { z } from "zod";

export const recordingsConfigSchema = z.strictObject({
  cacheBytes: z.int().positive().default(25_000_000_000),
});
