import { readLimitedJson } from "@home-agent/api/http/read-body";
import { z } from "zod";
import {
  AudioTrackMissing,
  encodedAudioSchema,
} from "../../perception/audio/encoded-stream";
import type { sourceAccessSchema } from "../../perception/sources";

export async function readAudioStream(
  access: z.infer<typeof sourceAccessSchema>,
  signal: AbortSignal,
) {
  const url = new URL(access.endpoint);
  url.pathname = "/api/home-agent/mijia/audio";
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal,
    headers: { "X-Home-Agent": "mijia", "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: access.sessionId,
      sourceId: access.sourceId,
    }),
  });
  if (!response.ok) {
    const result = z
      .object({ code: z.string().regex(/^[a-z_]{1,64}$/) })
      .safeParse(await readLimitedJson(response, 4096, signal));
    if (result.success && result.data.code === "audio_track_missing")
      throw new AudioTrackMissing("Camera has no audio track");
    throw new Error(
      `Audio stream unavailable (HTTP ${response.status}): ${result.success ? result.data.code : response.statusText}`,
    );
  }
  if (!response.body) throw new Error("Missing audio stream body");
  try {
    if (
      !response.headers
        .get("content-type")
        ?.startsWith("application/octet-stream")
    )
      throw new Error("Invalid audio stream content type");
    const metadata = encodedAudioSchema.parse({
      format: response.headers.get("x-audio-format"),
      generation: response.headers.get("x-audio-generation"),
      anchorReceivedAt: Number(response.headers.get("x-audio-received-at")),
      decodedStartOffsetMs: z.coerce
        .number()
        .parse(
          z
            .string()
            .min(1)
            .parse(response.headers.get("x-audio-start-offset-ms")),
        ),
    });
    return { ...metadata, stream: response.body };
  } catch (error) {
    await response.body.cancel();
    throw error;
  }
}
