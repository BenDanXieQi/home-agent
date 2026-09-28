import { fileURLToPath } from "node:url";
import { Piscina, queueOptionsSymbol } from "piscina";
import { detectionComputeBudget } from "./budget";
import { createInferenceQueue } from "./inference-queue";
import type run from "./inference-worker";
import { restoreError } from "./protocol";

// Lives exclusively inside the isolated compute process. Hard deadlines belong
// to the parent, which kills this whole process, never an in-flight ORT thread.
export function createInferencePool(
  modelPath: string,
  onFailure: (error: Error) => void,
) {
  if (
    detectionComputeBudget.workersPerProcess !== 1 ||
    detectionComputeBudget.tasksPerWorker !== 1
  )
    throw new Error(
      "Detection model ownership requires one worker and one task per worker",
    );
  const taskQueue = createInferenceQueue();
  const pool = new Piscina<
    Parameters<typeof run>[0],
    Awaited<ReturnType<typeof run>>
  >({
    filename: fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "./inference-worker.ts"
          : "./inference-worker.js",
        import.meta.url,
      ),
    ),
    workerData: { modelPath },
    minThreads: 0,
    maxThreads: detectionComputeBudget.workersPerProcess,
    idleTimeout: Infinity,
    maxQueue: detectionComputeBudget.pendingTasks,
    concurrentTasksPerWorker: detectionComputeBudget.tasksPerWorker,
    taskQueue,
  });
  const active = new Set<Promise<unknown>>();
  let closing:
    | Promise<Extract<Awaited<ReturnType<typeof run>>, { kind: "closed" }>>
    | undefined;
  let failure: Error | undefined;
  pool.on("error", (error: Error) => {
    failure ??= error;
    onFailure(error);
  });

  function submit(task: Parameters<typeof run>[0]) {
    if (closing) return Promise.reject(new Error("Inference pool is closing"));
    if (failure) return Promise.reject(failure);
    const buffer = task.kind === "detect" ? task.frame.rgb.buffer : undefined;
    const measurement = taskQueue.measureTask();
    const queuedTask = { ...task, [queueOptionsSymbol]: measurement.key };
    // IPC gave this process its own pixels. Transfer that copy to the worker;
    // the caller keeps its original pixels for annotation and reuse.
    const submitted = performance.now();
    const pending = pool
      .run(queuedTask, { transferList: buffer ? [buffer] : [] })
      .then((result) => {
        if (result.kind === "image_failed") throw restoreError(result);
        if (result.kind === "initialized" || result.kind === "closed")
          return result;
        const { workerMs, ...timing } = result.timing;
        const queueMs = measurement.queueMs;
        return {
          ...result,
          timing: {
            ...timing,
            queueMs,
            workerDispatchMs: Math.max(
              0,
              performance.now() - submitted - queueMs - workerMs,
            ),
          },
        };
      });
    active.add(pending);
    void pending.finally(() => active.delete(pending)).catch(() => {});
    return pending;
  }
  function close() {
    closing ??= (async () => {
      await Promise.allSettled(active);
      if (failure) throw failure;
      const result = await pool.run({ kind: "close" });
      if (result.kind !== "closed")
        throw new Error("Unexpected model release response");
      if (failure) throw failure;
      // Only close idle workers, after all native operations and release finish.
      // A stalled release/close is handled by the parent's process deadline.
      await pool.close();
      if (failure) throw failure;
      return result;
    })();
    return closing;
  }
  return { submit, close };
}
