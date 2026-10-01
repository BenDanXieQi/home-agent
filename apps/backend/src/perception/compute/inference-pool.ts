import { fileURLToPath } from "node:url";
import { Piscina, queueOptionsSymbol } from "piscina";
import type { z } from "zod";
import { computeBudgetSchema, detectionComputeBudget } from "./budget";
import { createInferenceQueue } from "./inference-queue";
import type run from "./inference-worker";
import { ComputeBusyError, restoreError } from "./protocol";

// One single-thread Piscina per model owner makes initialize/release addressable.
// This module owns their shared admission budget; no caller chooses a worker.
export function createInferencePool(
  onFailure: (error: Error) => void,
  budget: z.infer<typeof computeBudgetSchema>,
) {
  const settings = computeBudgetSchema.parse(budget);
  const availableListeners = new Map<() => void, () => boolean>();
  const active = new Set<Promise<unknown>>();
  let failure: Error | undefined;
  let initialized = false;
  let reservedTracking = 0;
  let closing:
    | Promise<Extract<Awaited<ReturnType<typeof run>>, { kind: "closed" }>>
    | undefined;
  const workers = Array.from({ length: settings.workersPerProcess }, () => {
    const queue = createInferenceQueue();
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
      minThreads: 0,
      maxThreads: 1,
      idleTimeout: Infinity,
      maxQueue: detectionComputeBudget.pendingTasks,
      concurrentTasksPerWorker: 1,
      taskQueue: queue,
    });
    pool.on("error", (error: Error) => {
      failure ??= error;
      const pending = queued;
      queued = undefined;
      pending?.reject(error);
      onFailure(error);
    });
    return { pool, queue, active: 0 };
  });
  let queued:
    | {
        start: (worker: (typeof workers)[number]) => void;
        reject: (error: unknown) => void;
      }
    | undefined;
  function dispatchQueued() {
    const idle =
      workers.reduce((sum, worker) => sum + worker.active, 0) <
      workers.length - reservedTracking
        ? workers.find((worker) => worker.active === 0)
        : undefined;
    if (!failure && queued && idle) {
      const task = queued;
      queued = undefined;
      task.start(idle);
    }
  }
  function track<T>(pending: Promise<T>) {
    active.add(pending);
    const release = () => {
      active.delete(pending);
      dispatchQueued();
      for (const listener of availableListeners.keys()) listener();
    };
    pending.then(release, release);
    return pending;
  }
  let initialization:
    | Promise<Awaited<ReturnType<typeof initialize>>>
    | undefined;
  async function initialize() {
    const results = await Promise.all(
      workers.map(async (worker) => {
        const result = await worker.pool.run({ kind: "initialize" });
        if (result.kind !== "initialized")
          throw new Error("Unexpected worker initialization response");
        return result.metadata;
      }),
    );
    if (failure) throw failure;
    const first = results[0]!;
    const { workerThreadId: firstThread, ...metadata } = first;
    const workerThreadIds = [
      firstThread,
      ...results.slice(1).map((result) => result.workerThreadId),
    ];
    if (new Set(workerThreadIds).size !== workers.length)
      throw new Error("Model worker identities are not unique");
    for (const { workerThreadId, ...other } of results) {
      if (JSON.stringify(other) !== JSON.stringify(metadata))
        throw new Error(`Model metadata differs in worker ${workerThreadId}`);
    }
    initialized = true;
    return {
      kind: "initialized" as const,
      metadata: { ...metadata, workerThreadIds },
    };
  }
  function submit(
    task: Parameters<typeof run>[0],
    onAdmitted?: () => Promise<void>,
  ) {
    if (closing) return Promise.reject(new Error("Inference pool is closing"));
    if (failure) return Promise.reject(failure);
    if (task.kind === "initialize") {
      initialization ??= track(
        initialize().catch((error: unknown) => {
          failure = error instanceof Error ? error : new Error(String(error));
          throw failure;
        }),
      );
      return initialization;
    }
    if (task.kind === "close") return close();
    if (!initialized)
      return Promise.reject(new Error("Inference pool is not initialized"));
    // Image requests can use the existing bounded wait slot even while video
    // is ready. dispatchQueued() admits it before waking video listeners.
    if (
      !onAdmitted &&
      task.kind !== "detect_image" &&
      [...availableListeners.values()].some((waiting) => waiting())
    )
      return Promise.reject(
        new ComputeBusyError("Compute turn reserved for ready video"),
      );
    if (
      active.size >=
      workers.length - reservedTracking + detectionComputeBudget.pendingTasks
    )
      return Promise.reject(
        new ComputeBusyError("Detection compute capacity busy"),
      );
    const idle =
      workers.reduce((sum, worker) => sum + worker.active, 0) <
      workers.length - reservedTracking
        ? workers.find((worker) => worker.active === 0)
        : undefined;
    if (!idle && (queued || onAdmitted))
      return Promise.reject(new ComputeBusyError("No idle inference worker"));
    const submitted = performance.now();
    async function execute(worker: (typeof workers)[number]) {
      const admittedAt = performance.now();
      const measurement = worker.queue.measureTask();
      const queuedTask = { ...task, [queueOptionsSymbol]: measurement.key };
      const buffer = task.kind === "detect" ? task.frame.rgb.buffer : undefined;
      if (onAdmitted) await onAdmitted();
      const result = await worker.pool.run(queuedTask, {
        transferList: buffer ? [buffer] : [],
      });
      if (result.kind === "image_failed") throw restoreError(result);
      if (result.kind !== "detected" && result.kind !== "image_detected")
        throw new Error("Unexpected worker detection response");
      const { workerMs, ...timing } = result.timing;
      const queueMs = admittedAt - submitted + measurement.queueMs;
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
    }
    const request =
      Promise.withResolvers<Awaited<ReturnType<typeof execute>>>();
    const pending = track(request.promise);
    const start = (worker: (typeof workers)[number]) => {
      worker.active++;
      execute(worker).then(
        (result) => {
          worker.active--;
          request.resolve(result);
        },
        (error) => {
          worker.active--;
          request.reject(error);
        },
      );
    };
    if (idle) start(idle);
    else queued = { start, reject: request.reject };
    return pending;
  }

  function close() {
    closing ??= (async () => {
      await Promise.allSettled(active);
      if (failure) throw failure;
      await Promise.all(
        workers.map(async (worker) => {
          const result = await worker.pool.run({ kind: "close" });
          if (result.kind !== "closed")
            throw new Error("Unexpected model release response");
          if (failure) throw failure;
          await worker.pool.close();
        }),
      );
      if (failure) throw failure;
      return { kind: "closed" as const };
    })();
    return closing;
  }
  return {
    submit,
    close,
    reserveTracking() {
      if (closing || failure || !initialized || workers.length < 2)
        return false;
      // Stop refilling this slot immediately, but let admitted detections drain.
      // A later request can start ReID as soon as the reserved CPU is free.
      reservedTracking = 1;
      return (
        workers.reduce((sum, worker) => sum + worker.active, 0) <=
        workers.length - reservedTracking
      );
    },
    releaseTracking() {
      reservedTracking = 0;
      dispatchQueued();
      for (const listener of availableListeners.keys()) listener();
    },
    get available() {
      return (
        !closing &&
        !failure &&
        initialized &&
        workers.reduce((sum, worker) => sum + worker.active, 0) <
          workers.length - reservedTracking
      );
    },
    subscribeAvailable(
      listener: () => void,
      waiting: () => boolean = () => false,
    ) {
      availableListeners.set(listener, waiting);
      return () => {
        availableListeners.delete(listener);
      };
    },
  };
}
