import { z } from "zod";

// Shared native-worker lifecycle; each analyzer supplies its actual result schema.
export function audioInferenceResponse<Result extends z.ZodType>(
  result: Result,
  modelSha256: string,
) {
  return z.union([
    z.object({
      kind: z.literal("ready"),
      modelSha256: z.literal(modelSha256),
      rssBytes: z.number().positive(),
    }),
    result,
    z.object({ kind: z.literal("pulse"), rssBytes: z.number().positive() }),
    z.object({ kind: z.literal("fatal"), error: z.string().max(4096) }),
  ]);
}
