import type { MediaPrompt } from "../analysis";

export function buildMimoPayload({
  modelId,
  systemPrompt,
  messages,
  options,
  payload,
}: MediaPrompt) {
  if (typeof payload !== "object" || payload === null)
    throw new Error("Invalid MiMo SDK request payload");

  return {
    ...payload,
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
    temperature: options.temperature,
    top_p: options.topP,
    stream: true,
    stream_options: { include_usage: true },
  };
}
