import { z } from "zod";
import type { Go2RtcAdapter } from "./go2rtc-adapter";
import { Go2RtcError } from "./go2rtc-adapter";
import { readLimitedJson } from "@home-agent/api/http/read-body";

export const recordingTransferLimits = Object.freeze({
  bytes: 96 * 1024 * 1024,
  downloadMs: 90_000,
});

const declaredBytesSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(recordingTransferLimits.bytes);

// The caller owns this bounded transfer and validates the received container.
export async function readRecordingFile(
  access: ReturnType<Go2RtcAdapter["recordingDownloadAccess"]>,
  startAt: number,
  signal: AbortSignal,
) {
  const scopedSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(recordingTransferLimits.downloadMs),
  ]);
  const response = await fetch(access.endpoint, {
    method: "POST",
    redirect: "error",
    signal: scopedSignal,
    headers: { "X-Home-Agent": "mijia", "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: access.sessionId,
      sourceId: access.sourceId,
      startAt,
    }),
  });
  if (!response.ok) {
    const error = z
      .object({ code: z.string().regex(/^[a-z_]{1,64}$/) })
      .safeParse(await readLimitedJson(response, 4096, scopedSignal));
    throw new Error(
      `Recording transfer unavailable: ${error.success ? error.data.code : "invalid_response"}`,
    );
  }
  if (
    !response.body ||
    response.headers.get("content-type") !== "application/octet-stream"
  ) {
    await response.body?.cancel();
    throw new Go2RtcError("invalid_response");
  }
  const declaredBytes = declaredBytesSchema.safeParse(
    response.headers.get("content-length"),
  );
  if (!declaredBytes.success) {
    await response.body.cancel();
    throw new Go2RtcError("invalid_response");
  }
  return {
    stream: response.body,
    declaredBytes: declaredBytes.data,
    signal: scopedSignal,
  };
}
