import type { identityEvidenceSchema } from "./evidence";
import { identityCapacity } from "@home-agent/api/contracts";
import models from "./models.json";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import pTimeout from "p-timeout";
import type { z } from "zod";
import { identityLimits, type identityConfigSchema } from "./config";
import { faceRequestSchema, faceResponseSchema } from "./protocol";

export class FaceProcessExitError extends Error {}

// One native process, one in-flight frame, no waiting queue. A timeout retires it.
export async function createFaceProcess(
  config: z.infer<typeof identityConfigSchema>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const child = spawn(
    config.python,
    [
      fileURLToPath(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "./opencv-worker.py"
            : "../identity/opencv-worker.py",
          import.meta.url,
        ),
      ),
      config.modelDirectory,
      JSON.stringify(identityCapacity),
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      signal,
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        OMP_NUM_THREADS: "1",
        OPENBLAS_NUM_THREADS: "1",
      },
    },
  );
  const ready = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  let loaded = false;
  let version = "";
  let error: Error | undefined;
  let pending:
    | ReturnType<
        typeof Promise.withResolvers<z.infer<typeof identityEvidenceSchema>>
      >
    | undefined;
  let stderr = "";
  child.stderr.on("data", (bytes: Buffer) => {
    stderr = (stderr + bytes.toString("utf8")).slice(-4096);
  });
  function fail(cause: unknown) {
    error ??= cause instanceof Error ? cause : new Error(String(cause));
    ready.reject(error);
    pending?.reject(error);
    pending = undefined;
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
  child.stdin.on("error", fail);
  child.stdout.on("error", fail);
  child.stderr.on("error", fail);
  child.on("error", (cause) => {
    fail(cause);
    if (child.pid === undefined) exited.resolve();
  });
  child.on("exit", () => {
    fail(new Error(stderr || "Face inference process exited"));
    exited.resolve();
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (error) return;
    try {
      if (line.length > 64 * 1024)
        throw new Error("Face response exceeds budget");
      const response = faceResponseSchema.parse(JSON.parse(line));
      if (response.kind === "ready") {
        if (loaded) throw new Error("Duplicate face initialization");
        loaded = true;
        version = response.opencv;
        ready.resolve();
      } else {
        if (!pending || !loaded) throw new Error("Unexpected face result");
        pending.resolve(response);
        pending = undefined;
      }
    } catch (cause) {
      fail(cause);
    }
  });
  async function close() {
    fail(new Error("Face process closed"));
    try {
      await pTimeout(exited.promise, {
        milliseconds: 3000,
        message: "Face process exit unconfirmed",
      });
    } catch (cause) {
      throw new FaceProcessExitError("Face process exit unconfirmed", {
        cause,
      });
    } finally {
      lines.close();
      child.stdin.destroy();
    }
  }
  try {
    await pTimeout(ready.promise, {
      milliseconds: identityLimits.startupTimeoutMs,
      signal,
    });
    signal.throwIfAborted();
  } catch (cause) {
    fail(cause);
    await close();
    throw cause;
  }
  return {
    metadata: {
      processId: child.pid,
      engine: "opencv" as const,
      provider: "cpu" as const,
      version,
      yunetSha256: models.models.yunet.sha256,
      sfaceSha256: models.models.sface.sha256,
    },
    get error() {
      return error?.message;
    },
    async extract(input: z.infer<typeof faceRequestSchema>, timeoutMs: number) {
      if (error) throw error;
      if (pending) throw new Error("Face inference is busy");
      const request = faceRequestSchema.parse(input);
      const result =
        Promise.withResolvers<z.infer<typeof identityEvidenceSchema>>();
      pending = result;
      child.stdin.write(JSON.stringify(request) + "\n", (cause) => {
        if (cause) fail(cause);
      });
      try {
        return await pTimeout(result.promise, { milliseconds: timeoutMs });
      } catch (cause) {
        fail(cause);
        throw cause;
      }
    },
    close,
  };
}
