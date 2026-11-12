import type { MediaPrompt } from "../analysis";

export function buildQwenPayload({ media: blocks, payload }: MediaPrompt) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("messages" in payload) ||
    !Array.isArray(payload.messages)
  )
    throw new Error("Invalid Qwen SDK request payload");

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
    throw new Error("Expected a Qwen user message for media");

  return {
    ...payload,
    messages: messages.with(index, {
      ...message,
      content: [
        ...(typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : message.content),
        ...blocks.map(({ media }) => {
          const data = media.data.toBase64();
          return media.kind === "video"
            ? {
                type: "video_url",
                video_url: { url: `data:video/mp4;base64,${data}` },
              }
            : {
                type: "input_audio",
                input_audio: { data: `data:;base64,${data}`, format: "mp3" },
              };
        }),
      ],
    }),
    modalities: ["text"],
  };
}
