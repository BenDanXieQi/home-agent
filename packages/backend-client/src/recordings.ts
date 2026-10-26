export async function readRecordingMediaResponse(
  response: Response,
  signal: AbortSignal,
) {
  const form = await response.formData();
  signal.throwIfAborted();
  const encoded = form.get("metadata");
  const media: Blob[] = form.getAll("media").map((part) => {
    if (!(part instanceof Blob) || !part.size)
      throw new SyntaxError("Recording media is missing");
    return part;
  });
  if (typeof encoded !== "string" || !media.length)
    throw new SyntaxError("Recording response is incomplete");

  const metadata: unknown = JSON.parse(encoded);
  if (!metadata || typeof metadata !== "object")
    throw new SyntaxError("Recording metadata is invalid");
  return {
    media,
    metadata,
    startedAt:
      "startedAt" in metadata && typeof metadata.startedAt === "number"
        ? metadata.startedAt
        : undefined,
    endedAt:
      "endedAt" in metadata && typeof metadata.endedAt === "number"
        ? metadata.endedAt
        : undefined,
    hasAudio:
      "hasAudio" in metadata && typeof metadata.hasAudio === "boolean"
        ? metadata.hasAudio
        : undefined,
  };
}
