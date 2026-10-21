import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "@home-agent/api/errors";
import {
  readLimitedBytes,
  ResponseBodyError,
} from "@home-agent/api/http/read-body";
import { DetectionPoolError } from "../perception/compute/pool";

export type UploadedMedia = { path: string; name: string };

export function createBoundedMediaUpload<T>(
  process: (
    files: UploadedMedia[],
    signal: AbortSignal,
    request: Request,
  ) => Promise<T>,
  shutdown: AbortSignal,
  timeoutMs: number,
  limits: {
    maxBytes: number;
    invalidCode: "perception_image_invalid" | "identity_recording_invalid";
    multipart?: {
      maxFiles: number;
      maxFileBytes: number;
      maxTotalBytes: number;
    };
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
          const uploads: UploadedMedia[] = [];
          if (limits.multipart) {
            const form = await new Response(bytes, {
              headers: {
                "Content-Type": request.headers.get("content-type") ?? "",
              },
            })
              .formData()
              .catch((cause: unknown) => {
                throw new AppError(limits.invalidCode, { cause });
              });
            const files = form.getAll("images");
            if (
              !files.length ||
              files.length > limits.multipart.maxFiles ||
              [...form.keys()].some((key) => key !== "images")
            )
              throw new AppError(limits.invalidCode);

            let total = 0;
            for (const file of files) {
              signal.throwIfAborted();
              if (!(file instanceof File) || !file.size)
                throw new AppError(limits.invalidCode);
              total += file.size;
              if (
                file.size > limits.multipart.maxFileBytes ||
                total > limits.multipart.maxTotalBytes
              )
                throw new AppError("request_too_large", {
                  params: { maxBytes: limits.multipart.maxTotalBytes },
                });
              const path = join(directory, `input-${uploads.length}`);
              await writeFile(path, new Uint8Array(await file.arrayBuffer()), {
                mode: 0o600,
                signal,
              });
              uploads.push({ path, name: file.name.slice(0, 512) });
            }
          } else {
            const path = join(directory, "input");
            await writeFile(path, bytes, { mode: 0o600, signal });
            uploads.push({ path, name: "input" });
          }
          return await process(uploads, signal, request);
        } finally {
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      })().finally(() => {
        uploading = false;
      });
      const result = await operation;
      signal.throwIfAborted();
      return result;
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
