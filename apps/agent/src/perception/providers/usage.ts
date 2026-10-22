import { z } from "zod";

const tokenCountSchema = z.number().nullish();
const openAIStreamEventSchema = z.object({
  usage: z
    .object({
      prompt_tokens: tokenCountSchema,
      completion_tokens: tokenCountSchema,
      prompt_tokens_details: z
        .object({
          cached_tokens: tokenCountSchema,
          audio_tokens: tokenCountSchema,
          video_tokens: tokenCountSchema,
        })
        .nullish(),
    })
    .nullish(),
});
const geminiStreamEventSchema = z.object({
  usageMetadata: z
    .object({
      promptTokenCount: tokenCountSchema,
      candidatesTokenCount: tokenCountSchema,
      thoughtsTokenCount: tokenCountSchema,
      cachedContentTokenCount: tokenCountSchema,
      promptTokensDetails: z
        .array(
          z.object({
            modality: z.string().optional(),
            tokenCount: tokenCountSchema,
          }),
        )
        .nullish(),
    })
    .nullish(),
});

export function extractMediaUsage(
  provider: "mimo" | "qwen" | "gemini",
  event: unknown,
) {
  if (provider === "gemini") {
    const { usageMetadata } = geminiStreamEventSchema.parse(event);
    if (!usageMetadata) return;

    let audioTokens = 0;
    let videoTokens = 0;
    for (const detail of usageMetadata.promptTokensDetails ?? []) {
      if (detail.tokenCount == null) continue;
      if (detail.modality === "AUDIO") audioTokens = detail.tokenCount;
      else if (detail.modality === "VIDEO") videoTokens = detail.tokenCount;
    }

    return {
      input_tokens: usageMetadata.promptTokenCount ?? 0,
      output_tokens:
        (usageMetadata.candidatesTokenCount ?? 0) +
        (usageMetadata.thoughtsTokenCount ?? 0),
      cached_tokens: usageMetadata.cachedContentTokenCount ?? 0,
      audio_tokens: audioTokens,
      video_tokens: videoTokens,
    };
  }

  const { usage } = openAIStreamEventSchema.parse(event);
  if (!usage) return;

  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
    cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    audio_tokens: usage.prompt_tokens_details?.audio_tokens ?? 0,
    video_tokens: usage.prompt_tokens_details?.video_tokens ?? 0,
  };
}
