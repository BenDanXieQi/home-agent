import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { z } from "zod";
import type {
  mijiaRecordingAvailabilityQuerySchema,
  mijiaRecordingPlaybackStateSchema,
} from "@home-agent/api/mijia-recordings";
import type { MijiaService } from "../service";
import {
  readRecordingFile,
  recordingTransferLimits,
} from "../media/recording-file";

export class SdRecordingSourceError extends Error {
  constructor(
    readonly reason: Extract<
      z.infer<typeof mijiaRecordingPlaybackStateSchema>,
      { state: "unavailable" }
    >["reason"],
    options?: ErrorOptions,
  ) {
    super(`SD recording ${reason}`, options);
  }
}

export function createSdRecordingSource(options: {
  mijia: Pick<
    MijiaService,
    "recordingAccess" | "readRecordings" | "sourceSnapshot"
  >;
  shutdown: AbortSignal;
}) {
  let mediaTools: typeof import("./media") | undefined;

  const access = options.mijia.recordingAccess.bind(options.mijia);
  function current(deviceId: string, channel: 1 | 2) {
    const input = {
      revision: options.mijia.sourceSnapshot().revision,
      deviceId,
      channel,
    };
    return { ...input, source: access(input.revision, deviceId, channel) };
  }
  async function index(
    input: Pick<
      z.infer<typeof mijiaRecordingAvailabilityQuerySchema>,
      "revision" | "deviceId" | "channel"
    >,
    query: Parameters<MijiaService["readRecordings"]>[3],
    signal: AbortSignal,
  ) {
    const source = access(input.revision, input.deviceId, input.channel);
    const scopedSignal = AbortSignal.any([
      signal,
      source.signal,
      options.shutdown,
    ]);
    scopedSignal.throwIfAborted();
    const result = await options.mijia.readRecordings(
      input.revision,
      input.deviceId,
      input.channel,
      query,
      scopedSignal,
    );
    scopedSignal.throwIfAborted();
    source.assertCurrent();
    return result;
  }
  async function download(
    source: ReturnType<MijiaService["recordingAccess"]>,
    startAt: number,
    path: string,
    signal: AbortSignal,
    openOutput: () => Writable,
  ) {
    const scopedSignal = AbortSignal.any([
      signal,
      source.signal,
      options.shutdown,
    ]);
    scopedSignal.throwIfAborted();
    source.assertCurrent();
    const transfer = await readRecordingFile(
      source.access,
      startAt,
      scopedSignal,
    );
    let received = 0;
    const bounded = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        transfer.signal.throwIfAborted();
        source.assertCurrent();
        received += chunk.byteLength;
        if (
          received > recordingTransferLimits.bytes ||
          received > transfer.declaredBytes
        )
          throw new SdRecordingSourceError("capacity_exceeded");
        controller.enqueue(chunk);
      },
    });
    let output;
    try {
      output = openOutput();
    } catch (cause) {
      await transfer.stream.cancel(cause);
      throw cause;
    }
    await pipeline(
      Readable.fromWeb(transfer.stream.pipeThrough(bounded)),
      output,
      { signal: transfer.signal },
    );
    transfer.signal.throwIfAborted();
    source.assertCurrent();
    if (received !== transfer.declaredBytes)
      throw new SdRecordingSourceError("download_failed");

    const tools = (mediaTools ??= await import("./media"));
    try {
      const media = await tools.inspectRecording(path, scopedSignal);
      return { bytes: received, media };
    } catch (cause) {
      scopedSignal.throwIfAborted();
      throw new SdRecordingSourceError("invalid_media", { cause });
    }
  }

  return { access, current, index, download };
}
