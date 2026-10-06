import type { z } from "zod";
import { audioInferenceResponse } from "./inference-protocol";
import { createInferenceProcess } from "../compute/inference-process";

export function createAudioInferenceProcess<
  Result extends { kind: "result"; id: string; rssBytes: number },
>(options: {
  entry: URL;
  job: z.ZodType<{ id: string; samples: Float32Array }>;
  result: z.ZodType<Result>;
  modelSha256: string;
  limits: {
    initializeTimeoutMs: number;
    inferenceTimeoutMs: number;
    closeTimeoutMs: number;
  };
}) {
  const response = audioInferenceResponse(options.result, options.modelSha256);
  let rssBytes: number | null = null;
  let modelSha256: string | null = null;
  const worker = createInferenceProcess<
    z.infer<typeof options.job>,
    Extract<z.infer<typeof response>, { kind: "ready" }>,
    Result
  >({
    entry: options.entry,
    input: options.job,
    ...options.limits,
    heartbeatMs: 5000,
    matches: (input, result) => input.id === result.id,
    decode(message) {
      const result = response.parse(message);
      if (result.kind === "fatal")
        return { kind: "failed" as const, error: result.error };
      rssBytes = result.rssBytes;
      if (result.kind === "ready") {
        modelSha256 = result.modelSha256;
        return { kind: "ready" as const, value: result };
      }
      if (result.kind === "pulse") return { kind: "pulse" as const };
      return { kind: "result" as const, value: result };
    },
  });
  return {
    get status() {
      return { ...worker.status, rssBytes, modelSha256 };
    },
    initialize: () => worker.initialize(),
    evaluate: (input: z.infer<typeof options.job>) =>
      worker.request(input, options.limits.inferenceTimeoutMs),
    interrupt() {
      worker.interrupt();
    },
    close: () => worker.close(),
  };
}
