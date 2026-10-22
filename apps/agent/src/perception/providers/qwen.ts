import type { MediaPrompt } from "../analysis";

export function buildQwenPayload({
  modelId,
  systemPrompt,
  messages,
  options,
}: MediaPrompt) {
  return {
    model: modelId,
    messages: [
      { role: "system", content: systemPrompt },
      ...messages.map(({ role, content }) => ({
        role,
        content: content.map((block) => {
          if (block.type === "media") {
            const { media } = block;
            const data = media.data.toBase64();
            return media.kind === "video"
              ? {
                  type: "video_url",
                  video_url: { url: `data:;base64,${data}` },
                }
              : {
                  type: "input_audio",
                  input_audio: { data: `data:;base64,${data}`, format: "m4a" },
                };
          }
          if (block.type === "text") return { type: "text", text: block.text };
          return {
            type: "image_url",
            image_url: { url: `data:${block.mimeType};base64,${block.data}` },
          };
        }),
      })),
    ],
    max_tokens: options.maxTokens,
    temperature: options.temperature,
    top_p: options.topP,
    stream: true,
    stream_options: { include_usage: true },
    modalities: ["text"],
  };
}
