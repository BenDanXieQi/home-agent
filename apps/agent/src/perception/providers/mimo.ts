import type { MediaPrompt } from "../analysis";

export function buildMimoPayload({
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
            const base64 = media.data.toBase64();
            return media.kind === "video"
              ? {
                  type: "video_url",
                  video_url: { url: `data:video/mp4;base64,${base64}` },
                  fps: media.fps,
                  media_resolution: "max",
                }
              : {
                  type: "input_audio",
                  input_audio: {
                    data: `data:audio/m4a;base64,${base64}`,
                    format: "m4a",
                  },
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
    max_completion_tokens: options.maxTokens,
    temperature: options.temperature,
    top_p: options.topP,
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: "disabled" },
  };
}
