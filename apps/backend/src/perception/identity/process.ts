import type { identityClassSchema } from "@home-agent/api/contracts";
import models from "./models.json";
import { createInferenceProcess } from "../compute/inference-process";
import { faceEngine } from "./processing-version";
import { z } from "zod";
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
  const worker = createInferenceProcess<
    | z.infer<typeof identityRequestSchema>
    | z.infer<typeof identityPrepareSchema>,
    Extract<z.infer<typeof identityResponseSchema>, { kind: "ready" }>,
    Exclude<
      z.infer<typeof identityResponseSchema>,
      { kind: "ready" | "failed" }
    >
  >({
    entry: new URL(
      import.meta.url.endsWith(".ts")
        ? "./process-entry.ts"
        : "../identity/process-entry.js",
      import.meta.url,
    ),
    args: [config.modelDirectory],
    signal,
    input: z.union([identityRequestSchema, identityPrepareSchema]),
    initializeTimeoutMs: identityLimits.startupTimeoutMs,
    closeTimeoutMs: 3000,
    decode(message) {
      const result = identityResponseSchema.parse(message);
      if (result.kind === "failed") return result;
      if (result.kind === "ready")
        return { kind: "ready" as const, value: result };
      return { kind: "result" as const, value: result };
    },
  });
  const preparations = new Map<
    z.infer<typeof identityClassSchema>,
    { available: boolean; error: string | undefined; retryAt: number }
  >();
  async function close() {
    try {
      await worker.close();
    } catch (cause) {
      throw new IdentityProcessExitError("Identity process exit unconfirmed", {
        cause,
      });
    }
  }
  let initialized: Awaited<ReturnType<typeof worker.initialize>>;
  try {
    initialized = await worker.initialize();
    signal.throwIfAborted();
  } catch (cause) {
    await close();
    throw cause;
  }
  return {
    metadata: {
      processId: worker.status.processId,
      engine: faceEngine.engine,
      provider: "cpu" as const,
      version: initialized.version,
      yunetSha256: models.models.yunet.sha256,
      sfaceSha256: models.models.sface.sha256,
      petSha256: models.models.pet.sha256,
    },
    get error() {
      return worker.status.error?.message;
    },
    async prepare(classes: z.infer<typeof identityPrepareSchema>["classes"]) {
      const result = await worker.request(
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
      const result = await worker.request(input, timeoutMs);
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
