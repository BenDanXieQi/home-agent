import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pTimeout from "p-timeout";
import { AppError } from "@home-agent/api/errors";
import {
  readLimitedBytes,
  ResponseBodyError,
} from "@home-agent/api/http/read-body";
import { DetectionPoolError } from "../perception/compute/pool";

// The upload owner holds temporary bytes until admitted processing has settled.
export function createBoundedMediaUpload<T>(
  process: (path: string, signal: AbortSignal, request: Request) => Promise<T>,
  shutdown: AbortSignal,
  timeoutMs: number,
  limits: {
    maxBytes: number;
    invalidCode: "perception_image_invalid" | "identity_recording_invalid";
  },
) {
  let uploading = false;
  return async (request: Request) => {
    if (uploading) throw new AppError("perception_busy");
    const body = request.body;
    if (!body) throw new AppError(limits.invalidCode);
    if (Number(request.headers.get("content-length")) > limits.maxBytes)
      throw new AppError("request_too_large", {
        params: { maxBytes: limits.maxBytes },
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
            limits.maxBytes,
            signal,
          );
          if (!bytes.length) throw new AppError(limits.invalidCode);
          signal.throwIfAborted();
          directory = await mkdtemp(join(tmpdir(), "home-agent-upload-"));
          const path = join(directory, "input");
          await writeFile(path, bytes, { mode: 0o600, signal });
          return await process(path, signal, request);
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
          params: { maxBytes: limits.maxBytes },
        });
      if (cause instanceof DetectionPoolError)
        throw new AppError(
          cause.code === "invalid_image"
            ? limits.invalidCode
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
