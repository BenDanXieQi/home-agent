import type { MediaPrompt } from "../analysis";

export function buildGeminiPayload({ media: blocks, payload }: MediaPrompt) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("contents" in payload) ||
    !Array.isArray(payload.contents)
  )
    throw new Error("Invalid Gemini SDK request payload");

  const contents: unknown[] = payload.contents;
  const index = contents.findLastIndex(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      message.role === "user",
  );
  const message = contents[index];
  if (
    typeof message !== "object" ||
    message === null ||
    !("parts" in message) ||
    !Array.isArray(message.parts)
  )
    throw new Error("Expected a Gemini user message for media");

  return {
    ...payload,
    contents: contents.with(index, {
      ...message,
      parts: [
        ...message.parts,
        ...blocks.map(({ media }) => {
          const data = media.data.toBase64();
          return media.kind === "video"
            ? {
                inlineData: { mimeType: "video/mp4", data },
                videoMetadata: { fps: media.fps },
              }
            : { inlineData: { mimeType: "audio/mpeg", data } };
        }),
      ],
    }),
  };
}
