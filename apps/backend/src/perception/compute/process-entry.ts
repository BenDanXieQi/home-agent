import { createReidProcess } from "../tracking/reid-process";
import { createTrackingRuntime } from "../tracking/runtime";
import { createVideoRuntime } from "../video/runtime";
import { readAnalysisStream } from "../../mijia/media/analysis-stream";
import { createInferencePool } from "./inference-pool";
import {
  errorDetails,
  requestSchema,
  responseSchema,
  commandSchema,
} from "./protocol";
import type { z } from "zod";

let pool: ReturnType<typeof createInferencePool> | undefined;
let video: ReturnType<typeof createVideoRuntime> | undefined;
let initialized = false;
let closing = false;
let failed = false;
function fail(error: unknown) {
  if (failed) return;
  failed = true;
  process.exitCode = 1;
  const details = errorDetails(error);
  console.error(details.stack ?? details.message);
  // Flush the fatal IPC message before leaving this isolated process.
  send({ kind: "fatal", ...details })
    .finally(() => process.exit(1))
    .catch((flushError: unknown) => {
      console.error("Fatal IPC flush failed", flushError);
    });
}
async function run(task: z.infer<typeof commandSchema>) {
  if (task.kind === "initialize") {
    if (pool) throw new Error("Inference pool is already created");
    pool = createInferencePool(fail, task.budget);
    const result = await pool.submit(task);
    video = createVideoRuntime({
      tracking: createTrackingRuntime({
        createModel: createReidProcess,
        reserveCompute: () => pool!.reserveTracking(),
        releaseCompute: () => {
          pool!.releaseTracking();
        },
        emit: (observation) =>
          send({
            kind: "video",
            payload: { event: "tracking", run: observation.run, observation },
          }),
        failure: (error) => {
          console.error("Tracking publication failed", error);
        },
      }),
      compute: {
        get available() {
          return pool!.available;
        },
        subscribeAvailable: (listener, waiting) =>
          pool!.subscribeAvailable(listener, waiting),
        async detect(frame, onAdmitted) {
          const detection = await pool!.submit(
            { kind: "detect", frame },
            onAdmitted,
          );
          if (detection.kind !== "detected")
            throw new Error("Unexpected video detection response");
          return detection;
        },
      },
      emit: (payload) => send({ kind: "video", payload }),
      fatal: fail,
    });
    initialized = true;
    return result;
  }
  if (!pool || !initialized) throw new Error("Inference pool is not ready");
  if (closing) throw new Error("Inference pool is closing");
  if (task.kind === "close") {
    closing = true;
    await video?.close();
    return await pool.close();
  }
  if (task.kind === "video_start") {
    video!.start({
      run: task.source.run,
      config: task.source.config,
      decoder: {
        executable: task.source.executable,
        read: (signal) => readAnalysisStream(task.source.access, signal),
      },
    });
    return { kind: "video_ack" as const };
  }
  if (task.kind === "video_stop") {
    await video!.stop(task.runId);
    return { kind: "video_ack" as const };
  }
  return await pool.submit(task);
}
function send(message: z.infer<typeof responseSchema>) {
  return new Promise<void>((resolve, reject) => {
    if (!process.connected || !process.send) {
      reject(new Error("Detection process IPC disconnected"));
      return;
    }
    process.send(message, (error: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
// Piscina, rather than an IPC promise chain, owns the compute queue.
process.on("message", (message: unknown) => {
  const receivedAt = performance.now();
  const request = requestSchema.safeParse(message);
  if (!request.success) {
    fail(request.error);
    return;
  }
  run(request.data.task)
    .then(
      (result) =>
        send({
          kind: "result",
          id: request.data.id,
          result,
          processingMs: performance.now() - receivedAt,
        }),
      (error: unknown) =>
        send({
          kind: "error",
          id: request.data.id,
          ...errorDetails(error),
        }),
    )
    .catch(fail);
});
// No thread termination here; losing the parent ends this isolated process.
process.on("disconnect", () => {
  const cleanup = video?.close() ?? Promise.resolve();
  cleanup.then(
    () => process.exit(failed ? 1 : 0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
});
send({ kind: "ready" }).catch(fail);
