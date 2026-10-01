import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pTimeout from "p-timeout";
import { AppError } from "@home-agent/api/errors";
import {
  imageLimits,
  imageDetectionResponseSchema,
} from "@home-agent/api/contracts";
import {
  readLimitedBytes,
  ResponseBodyError,
} from "@home-agent/api/http/read-body";
import type { createPerceptionService } from "./service";
import { DetectionPoolError } from "./compute/pool";

// HTTP owns the bounded upload and temporary file. The existing pool owns all
// decoding and native computation, including completion after a client leaves.
export function createImageUpload(
  service: Pick<ReturnType<typeof createPerceptionService>, "detectImage">,
  shutdown: AbortSignal,
  timeoutMs: number,
) {
  let uploading = false;
  return async (request: Request) => {
    if (uploading) throw new AppError("perception_busy");
    const body = request.body;
    if (!body) throw new AppError("perception_image_invalid");
    if (
      Number(request.headers.get("content-length")) > imageLimits.maxFileBytes
    )
      throw new AppError("request_too_large", {
        params: { maxBytes: imageLimits.maxFileBytes },
      });
    const signal = AbortSignal.any([
      request.signal,
      shutdown,
      AbortSignal.timeout(timeoutMs),
    ]);
    try {
      signal.throwIfAborted();
      uploading = true;
      const operation = (async () => {
        let directory: string | undefined;
        try {
          const bytes = await readLimitedBytes(
            new Response(body.pipeThrough(new TransformStream(), { signal })),
            imageLimits.maxFileBytes,
            signal,
          );
          if (!bytes.length) throw new AppError("perception_image_invalid");
          signal.throwIfAborted();
          directory = await mkdtemp(join(tmpdir(), "home-agent-image-"));
          const path = join(directory, "input");
          await writeFile(path, bytes, { mode: 0o600, signal });
          const result = await service.detectImage({ path }, signal);
          return imageDetectionResponseSchema.parse({
            kind: result.kind,
            inputSha256: result.inputSha256,
            width: result.width,
            height: result.height,
            detections: result.detections,
            timing: result.timing,
          });
        } finally {
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      })().finally(() => {
        uploading = false;
      });
      return await pTimeout(operation, { milliseconds: timeoutMs, signal });
    } catch (cause) {
      if (signal.aborted)
        throw new AppError(
          signal.reason instanceof DOMException &&
            signal.reason.name === "TimeoutError"
            ? "perception_timeout"
            : "request_cancelled",
          { cause },
        );
      if (cause instanceof AppError) throw cause;
      if (cause instanceof ResponseBodyError)
        throw new AppError("request_too_large", {
          cause,
          params: { maxBytes: imageLimits.maxFileBytes },
        });
      if (cause instanceof DetectionPoolError)
        throw new AppError(
          cause.code === "invalid_image"
            ? "perception_image_invalid"
            : cause.code === "busy"
              ? "perception_busy"
              : cause.code === "timeout"
                ? "perception_timeout"
                : cause.code === "worker_failed"
                  ? "perception_failed"
                  : "perception_unavailable",
          { cause },
        );
      throw new AppError("perception_unavailable", { cause });
    }
  };
}
