import type { identityClassSchema } from "@home-agent/api/contracts";
import models from "./models.json";
import { fork } from "node:child_process";
import { faceEngine } from "./processing-version";
import pTimeout from "p-timeout";
import type { z } from "zod";
import { identityLimits, type identityConfigSchema } from "./config";
import {
  identityRequestSchema,
  identityResponseSchema,
  identityPrepareSchema,
} from "./protocol";

export class IdentityProcessExitError extends Error {}

// One native process, one in-flight frame, no waiting queue. A timeout retires it.
export async function createIdentityProcess(
  config: z.infer<typeof identityConfigSchema>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const child = fork(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./process-entry.ts"
        : "../identity/process-entry.js",
      import.meta.url,
    ),
    [config.modelDirectory],
    {
      execPath: process.execPath,
      execArgv: [],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      signal,
      killSignal: "SIGKILL",
      env: { ...process.env, ORT_DISABLE_TELEMETRY: "1" },
    },
  );
  const ready = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  let loaded = false;
  let version = "";
  const preparations = new Map<
    z.infer<typeof identityClassSchema>,
    { available: boolean; error: string | undefined; retryAt: number }
  >();
  let error: Error | undefined;
  let pending:
    | ReturnType<
        typeof Promise.withResolvers<
          Exclude<
            z.infer<typeof identityResponseSchema>,
            { kind: "ready" | "failed" }
          >
        >
      >
    | undefined;
  let stderr = "";
  child.stderr!.on("data", (bytes: Buffer) => {
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
  child.stderr!.on("error", fail);
  child.on("error", (cause) => {
    fail(cause);
    if (child.pid === undefined) exited.resolve();
  });
  child.on("exit", () => {
    fail(new Error(stderr || "Identity inference process exited"));
    exited.resolve();
  });
  child.on("disconnect", () => {
    fail(new Error("Identity inference IPC disconnected"));
  });
  child.on("message", (message: unknown) => {
    if (error) return;
    try {
      const response = identityResponseSchema.parse(message);
      if (response.kind === "failed") throw new Error(response.error);
      if (response.kind === "ready") {
        if (loaded) throw new Error("Duplicate identity initialization");
        loaded = true;
        version = response.version;
        ready.resolve();
      } else {
        if (!pending || !loaded) throw new Error("Unexpected identity result");
        pending.resolve(response);
        pending = undefined;
      }
    } catch (cause) {
      fail(cause);
    }
  });
  async function close() {
    fail(new Error("Identity process closed"));
    try {
      await pTimeout(exited.promise, {
        milliseconds: 3000,
        message: "Identity process exit unconfirmed",
      });
    } catch (cause) {
      throw new IdentityProcessExitError("Identity process exit unconfirmed", {
        cause,
      });
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
  async function request(
    input:
      | z.infer<typeof identityRequestSchema>
      | z.infer<typeof identityPrepareSchema>,
    timeoutMs: number,
  ) {
    if (error) throw error;
    if (pending) throw new Error("Identity inference is busy");
    const message =
      input.kind === "prepare"
        ? identityPrepareSchema.parse(input)
        : identityRequestSchema.parse(input);
    const result =
      Promise.withResolvers<
        Exclude<
          z.infer<typeof identityResponseSchema>,
          { kind: "ready" | "failed" }
        >
      >();
    pending = result;
    try {
      child.send(message, (cause) => {
        if (cause) fail(cause);
      });
    } catch (cause) {
      fail(cause);
    }
    try {
      return await pTimeout(result.promise, { milliseconds: timeoutMs });
    } catch (cause) {
      fail(cause);
      throw cause;
    }
  }
  return {
    metadata: {
      processId: child.pid,
      engine: faceEngine.engine,
      provider: "cpu" as const,
      version,
      yunetSha256: models.models.yunet.sha256,
      sfaceSha256: models.models.sface.sha256,
      petSha256: models.models.pet.sha256,
    },
    get error() {
      return error?.message;
    },
    async prepare(classes: z.infer<typeof identityPrepareSchema>["classes"]) {
      const result = await request(
        { kind: "prepare", classes },
        identityLimits.startupTimeoutMs,
      );
      if (result.kind !== "prepared")
        throw new Error("Unexpected identity preparation response");
      for (const className of classes) {
        const failure = result.failures.find(
          (item) => item.className === className,
        );
        preparations.set(className, {
          available: result.available.includes(className),
          error: failure?.error,
          retryAt: performance.now() + identityLimits.restartDelayMs,
        });
      }
      return result;
    },
    status(className: z.infer<typeof identityClassSchema>) {
      const preparation = preparations.get(className);
      return {
        status: preparation?.available
          ? ("available" as const)
          : preparation?.error && performance.now() < preparation.retryAt
            ? ("unavailable" as const)
            : ("not_checked" as const),
        reason:
          preparation?.error && performance.now() < preparation.retryAt
            ? "该物种的身份模型不可用，请检查模型文件或等待重试"
            : null,
      };
    },
    async extract(
      input: z.infer<typeof identityRequestSchema>,
      timeoutMs: number,
    ) {
      const result = await request(input, timeoutMs);
      if (result.kind === "unavailable") {
        if (input.kind !== "tracking")
          preparations.set(input.className, {
            available: false,
            error: result.error,
            retryAt: performance.now() + identityLimits.restartDelayMs,
          });
        throw new Error(result.error);
      }
      if (result.kind === "result")
        for (const failure of result.failures) {
          preparations.set(failure.className, {
            available: false,
            error: failure.error,
            retryAt: performance.now() + identityLimits.restartDelayMs,
          });
        }
      if (result.kind === "prepared")
        throw new Error("Unexpected identity extraction response");
      return result;
    },
    close,
  };
}
