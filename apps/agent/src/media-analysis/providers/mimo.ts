import type { MediaPrompt } from "../analysis";

export function buildMimoPayload({ media: blocks, payload }: MediaPrompt) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("messages" in payload) ||
    !Array.isArray(payload.messages)
  )
    throw new Error("Invalid MiMo SDK request payload");

  const messages: unknown[] = payload.messages;
  const index = messages.findLastIndex(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      message.role === "user",
  );
  const message = messages[index];
  if (
    typeof message !== "object" ||
    message === null ||
    !("content" in message) ||
    !(typeof message.content === "string" || Array.isArray(message.content))
  )
    throw new Error("Expected a MiMo user message for media");

  return {
    ...payload,
    messages: messages.with(index, {
      ...message,
      content: [
        ...(typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : message.content),
        ...blocks.map(({ media }) => {
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
                  data: `data:audio/mpeg;base64,${base64}`,
                  format: "mp3",
                },
              };
        }),
      ],
    }),
  };
}
