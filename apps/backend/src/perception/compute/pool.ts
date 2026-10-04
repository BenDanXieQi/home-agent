import type { videoEventSchema } from "../video/events";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import pTimeout from "p-timeout";
import { frameSchema } from "../detection/frame";
import { createDetectionProcess } from "./process";
import {
  detectionComputeBudget,
  cpuRatioSchema,
  resolveComputeBudget,
} from "./budget";
import {
  ComputeBusyError,
  errorDetails,
  commandSchema,
  videoStartSchema,
} from "./protocol";
import {
  ImageProcessingError,
  imageRequestSchema,
} from "../detection/image-request";

const optionsSchema = z.object({
  cpuRatio: cpuRatioSchema,
  workerLimit: z.int().positive().optional(),
  initializeTimeoutMs: z.int().positive().max(300_000).default(30_000),
  taskTimeoutMs: z.int().positive().max(300_000).default(10_000),
  closeTimeoutMs: z.int().min(100).max(300_000).default(10_000),
  recoveryDelayMs: z.int().nonnegative().max(30_000).default(250),
  recoveryResetMs: z.int().positive().max(3_600_000).default(60_000),
  maxRestarts: z.int().nonnegative().max(3).default(2),
});

export class DetectionPoolError extends Error {
  constructor(
    readonly code:
      | "timeout"
      | "closed"
      | "busy"
      | "unavailable"
      | "worker_failed"
      | ImageProcessingError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DetectionPoolError";
  }
}

// A deadline bounds the caller's wait. Native termination is confirmed separately.
function within<T>(
  operation: Promise<T>,
  milliseconds: number,
  label: string,
  signal?: AbortSignal,
) {
  if (signal?.aborted) {
    // The operation has already started, so its later rejection still needs an observer.
    return Promise.race([Promise.reject<T>(signal.reason), operation]);
  }
  return pTimeout(operation, {
    // Like setTimeout(0), an exhausted budget expires on the next timer turn.
    milliseconds: Math.max(1, milliseconds),
    message: new DetectionPoolError(
      "timeout",
      `${label} exceeded ${milliseconds}ms`,
    ),
    ...(signal ? { signal } : {}),
  });
}

export async function createDetectionPool(
  input: z.input<typeof optionsSchema> = {},
  shutdownSignal?: AbortSignal,
) {
  const options = optionsSchema.parse(input);
  const resolved = resolveComputeBudget(options.cpuRatio);
  const budget = {
    ...resolved,
    workersPerProcess: Math.min(
      resolved.workersPerProcess,
      options.workerLimit ?? resolved.workersPerProcess,
    ),
  };
  const capacity =
    detectionComputeBudget.processes *
      budget.workersPerProcess *
      detectionComputeBudget.tasksPerWorker +
    detectionComputeBudget.pendingTasks;
  let current: ReturnType<typeof createDetectionProcess> | undefined;
  let status:
    | "starting"
    | "ready"
    | "recovering"
    | "unavailable"
    | "closing"
    | "closed" = "starting";
  let lastError: Error | undefined;
  let restarts = 0;
  let consecutiveRestarts = 0;
  let healthySince: number | undefined;
  let recovery: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const stopping = new AbortController();
  const onShutdown = () => stopping.abort(new Error("Perception stopping"));
  shutdownSignal?.addEventListener("abort", onShutdown, { once: true });
  if (shutdownSignal?.aborted) onShutdown();
  const videoListeners = new Set<
    (event: z.infer<typeof videoEventSchema>) => void
  >();
  const statusListeners = new Set<() => void>();
  const notifyStatus = () => {
    for (const listener of statusListeners) listener();
  };
  const active = new Set<Promise<unknown>>();
  let activeRgbBytes = 0;
  let activeImageRequests = 0;
  let activeControls = 0;
  function recordHealthy(now = performance.now()) {
    healthySince ??= now;
    if (now - healthySince >= options.recoveryResetMs) consecutiveRestarts = 0;
  }

  async function retire(
    generation: ReturnType<typeof createDetectionProcess>,
    milliseconds = options.closeTimeoutMs,
  ) {
    await within(generation.destroy(), milliseconds, "Process termination");
  }

  async function initialize() {
    const generation = createDetectionProcess(options.taskTimeoutMs);
    generation.events.on("video", (event: z.infer<typeof videoEventSchema>) => {
      if (current === generation && status === "ready") {
        if (event.event === "settled") recordHealthy();
        for (const listener of videoListeners) listener(event);
      }
    });
    current = generation;
    generation.events.on("error", (cause: Error) => {
      fail(
        generation,
        new DetectionPoolError("worker_failed", "Detection process failed", {
          cause,
        }),
      );
    });
    try {
      const result = await within(
        generation.submit({ kind: "initialize", budget }),
        options.initializeTimeoutMs,
        "Model initialization",
        stopping.signal,
      );
      if (result.kind !== "initialized")
        throw new Error("Unexpected initialization response");
      if (generation.signal.aborted) throw generation.signal.reason;
      return result.metadata;
    } catch (error) {
      generation.abort(error);
      // Never overlap a replacement with a process whose termination is unconfirmed.
      await retire(generation);
      throw error;
    }
  }

  function fail(
    generation: ReturnType<typeof createDetectionProcess>,
    cause: Error,
  ) {
    generation.abort(cause);
    if (current !== generation || status !== "ready") return;
    lastError = cause;
    healthySince = undefined;
    status = "recovering";
    notifyStatus();
    recovery = recover(generation);
  }

  async function recover(
    generation: ReturnType<typeof createDetectionProcess>,
    limit = options.maxRestarts,
  ) {
    try {
      await retire(generation);
      while (!stopping.signal.aborted && consecutiveRestarts < limit) {
        restarts++;
        consecutiveRestarts++;
        await delay(
          options.recoveryDelayMs * 2 ** (consecutiveRestarts - 1),
          undefined,
          {
            signal: stopping.signal,
          },
        );
        try {
          metadata = await initialize();
          if (!stopping.signal.aborted) {
            status = "ready";
            notifyStatus();
          }
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          // initialize() leaves the generation in current, including failed startup.
          // Confirm cleanup before retrying; an unconfirmed process exit stops recovery.
          if (current) await retire(current);
        }
      }
      if (!stopping.signal.aborted) {
        status = "unavailable";
        notifyStatus();
      }
    } catch (error) {
      if (!stopping.signal.aborted) {
        lastError = error instanceof Error ? error : new Error(String(error));
        status = "unavailable";
        notifyStatus();
      }
    }
  }

  async function retry() {
    if (stopping.signal.aborted)
      throw new DetectionPoolError("closed", "Detection pool is closed");
    if (status === "ready") return;
    if (status === "unavailable" && current) {
      consecutiveRestarts = 0;
      healthySince = undefined;
      status = "recovering";
      notifyStatus();
      recovery = recover(current, Math.max(1, options.maxRestarts));
    }
    await recovery;
    if (stopping.signal.aborted)
      throw new DetectionPoolError("closed", "Detection pool is closed");
    if (getStatus().status !== "ready")
      throw new DetectionPoolError("unavailable", "Detection recovery failed", {
        cause: lastError,
      });
  }

  let metadata = await initialize().catch((cause: unknown) => {
    shutdownSignal?.removeEventListener("abort", onShutdown);
    throw cause;
  });
  status = "ready";

  function submitDetection(
    request: Extract<
      z.infer<typeof commandSchema>,
      { kind: "detect" | "detect_image" }
    >,
    submitted: number,
  ) {
    const generation = current;
    if (stopping.signal.aborted)
      return Promise.reject(
        new DetectionPoolError("closed", "Detection pool is closed"),
      );
    if (status !== "ready" || !generation)
      return Promise.reject(
        new DetectionPoolError("unavailable", `Detection pool is ${status}`, {
          cause: lastError,
        }),
      );
    if (active.size >= capacity)
      return Promise.reject(
        new DetectionPoolError(
          "busy",
          "Detection IPC request capacity exhausted",
        ),
      );
    const rgbBytes =
      request.kind === "detect" ? request.frame.rgb.byteLength : 0;
    const imageRequest = request.kind === "detect_image";
    const deadline = submitted + options.taskTimeoutMs;
    const task = (async () => {
      try {
        const result = await within(
          generation.submit(request),
          Math.max(0, deadline - performance.now()),
          "Detection including queue wait",
        );
        if (
          !("timing" in result) ||
          (imageRequest
            ? result.kind !== "image_detected"
            : result.kind !== "detected")
        )
          throw new Error("Unexpected detection response");
        const acceptedAt = performance.now();
        if (acceptedAt >= deadline)
          throw new DetectionPoolError(
            "timeout",
            "Detection deadline elapsed before result acceptance",
          );
        if (current !== generation || generation.signal.aborted)
          throw new DetectionPoolError(
            "unavailable",
            "Result belongs to a retired process",
          );
        recordHealthy(acceptedAt);
        const totalMs = acceptedAt - submitted;
        const processingMs =
          result.timing.readMs +
          result.timing.decodeMs +
          result.timing.preprocessMs +
          result.timing.inferenceMs +
          result.timing.postprocessMs;
        return {
          ...result,
          timing: {
            ...result.timing,
            totalMs,
            dispatchMs: Math.max(0, totalMs - processingMs),
          },
        };
      } catch (error) {
        if (
          error instanceof ImageProcessingError ||
          error instanceof ComputeBusyError
        )
          throw new DetectionPoolError(error.code, error.message, {
            cause: error,
          });
        const failure =
          error instanceof DetectionPoolError
            ? error
            : new DetectionPoolError("worker_failed", "Detection failed", {
                cause: error,
              });
        fail(generation, failure);
        throw failure;
      }
    })();
    active.add(task);
    activeRgbBytes += rgbBytes;
    if (imageRequest) activeImageRequests++;
    function releaseRequest() {
      active.delete(task);
      activeRgbBytes -= rgbBytes;
      if (imageRequest) activeImageRequests--;
    }
    task.then(releaseRequest, releaseRequest);
    return task;
  }

  async function detect(inputFrame: z.infer<typeof frameSchema>) {
    const submitted = performance.now();
    // Caller validation precedes admission and never consumes recovery budget.
    const frame = frameSchema.parse(inputFrame);
    const result = await submitDetection({ kind: "detect", frame }, submitted);
    if (result.kind !== "detected")
      throw new Error("Unexpected detection response");
    return result;
  }

  async function detectImage(imageInput: z.input<typeof imageRequestSchema>) {
    const submitted = performance.now();
    const image = imageRequestSchema.parse(imageInput);
    const result = await submitDetection(
      {
        kind: "detect_image",
        image,
      },
      submitted,
    );
    if (result.kind !== "image_detected")
      throw new Error("Unexpected image detection response");
    return result;
  }

  function close() {
    if (closing) return closing;
    status = "closing";
    notifyStatus();
    shutdownSignal?.removeEventListener("abort", onShutdown);
    stopping.abort(
      new DetectionPoolError("closed", "Detection pool is closing"),
    );
    closing = (async () => {
      const deadline = performance.now() + options.closeTimeoutMs;
      let shutdownError: unknown;
      let terminated = true;
      try {
        // Reserve half the total deadline for forced termination if draining stalls.
        await within(
          (async () => {
            await Promise.allSettled(active);
            await recovery;
            if (current && !current.signal.aborted) {
              await current.submit({ kind: "close" });
            }
          })(),
          Math.floor(options.closeTimeoutMs / 2),
          "Graceful detection shutdown",
        );
      } catch (error) {
        shutdownError = error;
      } finally {
        if (current) {
          current.abort(
            new DetectionPoolError("closed", "Detection pool is closed"),
          );
          try {
            await retire(current, Math.max(1, deadline - performance.now()));
          } catch (error) {
            shutdownError = error;
            terminated = false;
          }
        }
        try {
          await within(
            Promise.allSettled(active),
            Math.max(0, deadline - performance.now()),
            "Detection request cleanup",
          );
        } catch (error) {
          shutdownError = error;
          terminated = false;
        }
        status = terminated ? "closed" : "unavailable";
      }
      if (shutdownError) {
        lastError =
          shutdownError instanceof Error
            ? shutdownError
            : new Error("Detection shutdown failed", { cause: shutdownError });
        throw shutdownError;
      }
    })();
    return closing;
  }

  async function videoControl(
    task: Extract<
      z.infer<typeof commandSchema>,
      { kind: "video_start" | "video_stop" }
    >,
  ) {
    const generation = current;
    if (status !== "ready" || !generation)
      throw new DetectionPoolError("unavailable", "Video compute unavailable");
    if (activeControls >= 16)
      throw new DetectionPoolError(
        "busy",
        "Video IPC control capacity exhausted",
      );
    activeControls++;
    try {
      const result = await within(
        generation.submit(task),
        options.closeTimeoutMs,
        "Video control",
        stopping.signal,
      );
      if (result.kind !== "video_ack")
        throw new Error("Unexpected video control response");
    } catch (error) {
      if (!(error instanceof ComputeBusyError))
        fail(generation, new Error("Video control failed", { cause: error }));
      throw error;
    } finally {
      activeControls--;
    }
  }
  function getStatus() {
    return {
      status,
      budget,
      restarts,
      consecutiveRestarts,
      lastError: lastError ? errorDetails(lastError).message : undefined,
      processId: current?.pid,
      activeRequests: active.size,
      activeRgbBytes,
      activeImageRequests,
    };
  }
  return {
    get metadata() {
      return metadata;
    },
    detect,
    detectImage,
    close,
    retry,
    getStatus,
    subscribeStatus(listener: () => void) {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    startVideo(source: z.infer<typeof videoStartSchema>) {
      return videoControl({
        kind: "video_start",
        source: videoStartSchema.parse(source),
      });
    },
    stopVideo(runId: string) {
      return videoControl({ kind: "video_stop", runId });
    },
    subscribeVideo(
      listener: (event: z.infer<typeof videoEventSchema>) => void,
    ) {
      videoListeners.add(listener);
      return () => {
        videoListeners.delete(listener);
      };
    },
  };
}
