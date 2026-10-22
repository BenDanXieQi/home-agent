import type { MediaPrompt } from "../analysis";

export function buildGeminiPayload({
  modelId,
  systemPrompt,
  messages,
  signal,
  options,
  payload,
}: MediaPrompt) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("config" in payload) ||
    typeof payload.config !== "object" ||
    payload.config === null
  )
    throw new Error("Invalid Gemini SDK request payload");

  return {
    ...payload,
    model: modelId,
    contents: messages.map(({ role, content }) => ({
      role,
      parts: content.map((block) => {
        if (block.type === "media") {
          const { media } = block;
          const data = media.data.toBase64();
          return media.kind === "video"
            ? {
                inlineData: { mimeType: "video/mp4", data },
                videoMetadata: { fps: media.fps },
              }
            : { inlineData: { mimeType: "audio/mp4", data } };
        }
        if (block.type === "text") return { text: block.text };
        return { inlineData: { mimeType: block.mimeType, data: block.data } };
      }),
    })),
    config: {
      ...payload.config,
      systemInstruction: systemPrompt,
      abortSignal: signal,
      httpOptions: { timeout: options.timeoutMs },
      maxOutputTokens: options.maxTokens,
      temperature: options.temperature,
      topP: options.topP,
      ...(options.mediaResolution === "high"
        ? { mediaResolution: "MEDIA_RESOLUTION_HIGH" }
        : {}),
    },
  };
}
