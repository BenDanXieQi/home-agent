import type { z } from "zod";
import { reidResponseSchema, reidRequestSchema } from "./reid-protocol";
import { createInferenceProcess } from "../compute/inference-process";

function createWorker() {
  return createInferenceProcess<
    z.infer<typeof reidRequestSchema>,
    Extract<z.infer<typeof reidResponseSchema>, { kind: "ready" }>,
    Extract<
      z.infer<typeof reidResponseSchema>,
      { kind: "features" }
    >["features"]
  >({
    entry: new URL(
      import.meta.url.endsWith(".ts")
        ? "./reid-entry.ts"
        : "../tracking/reid-entry.js",
      import.meta.url,
    ),
    input: reidRequestSchema,
    initializeTimeoutMs: 30000,
    closeTimeoutMs: 3000,
    decode(message) {
      const result = reidResponseSchema.parse(message);
      if (result.kind === "failed") return result;
      if (result.kind === "ready")
        return { kind: "ready" as const, value: result };
      return { kind: "result" as const, value: result.features };
    },
  });
}

export function createReidProcess() {
  let worker: ReturnType<typeof createWorker> | undefined;
  let stopped = false;
  return {
    start() {
      if (!worker && !stopped) worker = createWorker();
    },
    get status() {
      return {
        ready: worker?.status.ready ?? false,
        busy: worker?.status.busy ?? false,
        error: worker?.status.error?.message,
        pid: worker?.status.processId,
      };
    },
    extract(input: z.infer<typeof reidRequestSchema>, timeoutMs: number) {
      if (!worker || stopped)
        return Promise.reject(new Error("ReID unavailable"));
      return worker.request(input, timeoutMs);
    },
    async close() {
      stopped = true;
      await worker?.close();
    },
  };
}
