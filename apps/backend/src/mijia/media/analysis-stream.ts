import { sourceMediaSchema } from "@home-agent/api/contracts";
import { readLimitedJson } from "@home-agent/api/http/read-body";
import { z } from "zod";

export const analysisAccessSchema = z.strictObject({
  endpoint: z.url(),
  sessionId: z.uuid(),
  sourceId: z.uuid(),
});
// Only the trusted composition root supplies this descriptor, never an HTTP client.
export async function readAnalysisStream(
  access: z.infer<typeof analysisAccessSchema>,
  signal: AbortSignal,
) {
  const response = await fetch(access.endpoint, {
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
    const parsed = z
      .object({ code: z.string().regex(/^[a-z_]{1,64}$/) })
      .safeParse(await readLimitedJson(response, 4096, signal));
    throw new Error(
      `Analysis stream unavailable: ${parsed.success ? parsed.data.code : "invalid_response"} (HTTP ${response.status})`,
    );
  }
  if (
    !response.body ||
    !response.headers.get("content-type")?.startsWith("video/mp2t")
  ) {
    await response.body?.cancel();
    throw new Error(`Analysis stream unavailable (HTTP ${response.status})`);
  }
  try {
    const media = sourceMediaSchema.parse({
      generation: response.headers.get("x-media-generation"),
      clockRate: Number(response.headers.get("x-media-clock-rate")),
    });
    const ptsOrigin = z.coerce
      .number()
      .int()
      .min(0)
      .max(0xffffffff)
      .parse(
        z
          .string()
          .regex(/^(0|[1-9][0-9]{0,9})$/)
          .parse(response.headers.get("x-media-pts-origin")),
      );
    return { stream: response.body, media, ptsOrigin };
  } catch (error) {
    await response.body.cancel();
    throw error;
  }
}
