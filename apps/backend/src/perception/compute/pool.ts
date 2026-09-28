import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { frameSchema } from "../detection/frame";
import { createDetectionProcess } from "./process";
import { detectionComputeBudget } from "./budget";
import { errorDetails, taskSchema } from "./protocol";
import {
  ImageProcessingError,
  imageRequestSchema,
} from "../detection/image-request";
import { createAnnotationOutputs } from "../detection/annotation-output";

const optionsSchema = z.object({
  initializeTimeoutMs: z.int().positive().max(300_000).default(30_000),
  taskTimeoutMs: z.int().positive().max(300_000).default(10_000),
  closeTimeoutMs: z.int().min(100).max(300_000).default(10_000),
  recoveryDelayMs: z.int().nonnegative().max(30_000).default(250),
  maxRestarts: z.int().nonnegative().max(3).default(2),
});

export class DetectionPoolError extends Error {
  readonly outputPath: string | undefined;
  constructor(
    readonly code:
      | "timeout"
      | "closed"
      | "busy"
      | "unavailable"
      | "worker_failed"
      | "output_commit_unknown"
      | ImageProcessingError["code"],
    message: string,
    options?: ErrorOptions & { outputPath?: string | undefined },
  ) {
    super(message, options);
    this.name = "DetectionPoolError";
    this.outputPath = options?.outputPath;
  }
}

// A deadline bounds the caller's wait. Native termination is confirmed separately.
async function within<T>(
  operation: Promise<T>,
  milliseconds: number,
  label: string,
  signal?: AbortSignal,
) {
  const interrupted = Promise.withResolvers<never>();
  const onAbort = () => interrupted.reject(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () =>
      interrupted.reject(
        new DetectionPoolError(
          "timeout",
          `${label} exceeded ${milliseconds}ms`,
        ),
      ),
    milliseconds,
  );
  try {
    return await Promise.race([operation, interrupted.promise]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function createDetectionPool(
  modelPath: string,
  input: z.input<typeof optionsSchema> = {},
) {
  const options = optionsSchema.parse(input);
  const capacity =
    detectionComputeBudget.processes *
      detectionComputeBudget.workersPerProcess *
      detectionComputeBudget.tasksPerWorker +
    detectionComputeBudget.pendingTasks;
  const absoluteModelPath = resolve(modelPath);
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
  let recovery: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const stopping = new AbortController();
  const endingWaits = new AbortController();
  const active = new Set<Promise<unknown>>();
  const outputs = createAnnotationOutputs();
  let outputFailure: Error | undefined;
  let activeRgbBytes = 0;
  let activeImageRequests = 0;

  async function retire(
    generation: ReturnType<typeof createDetectionProcess>,
    milliseconds = options.closeTimeoutMs,
  ) {
    await within(
      (async () => {
        await generation.destroy();
        // A native image writer may outlive its task deadline. Remove its files
        // only after the OS confirms that this generation can no longer write.
        await outputs.retire(generation);
      })(),
      milliseconds,
      "Process termination and staged image cleanup",
    );
  }

  async function initialize() {
    const generation = createDetectionProcess();
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
        generation.submit({ kind: "initialize", modelPath: absoluteModelPath }),
        options.initializeTimeoutMs,
        "Model initialization",
        AbortSignal.any([generation.failure.signal, stopping.signal]),
      );
      if (result.kind !== "initialized")
        throw new Error("Unexpected initialization response");
      if (generation.failure.signal.aborted)
        throw generation.failure.signal.reason;
      return result.metadata;
    } catch (error) {
      generation.failure.abort(error);
      // Never overlap a replacement with a process whose termination is unconfirmed.
      await retire(generation);
      throw error;
    }
  }

  function fail(
    generation: ReturnType<typeof createDetectionProcess>,
    cause: Error,
  ) {
    if (generation.failure.signal.aborted) return;
    generation.failure.abort(cause);
    if (current !== generation) return;
    lastError = cause;
    if (status === "ready") {
      status = "recovering";
      recovery = recover(generation);
    }
  }

  async function recover(
    generation: ReturnType<typeof createDetectionProcess>,
  ) {
    try {
      await retire(generation);
      while (!stopping.signal.aborted && restarts < options.maxRestarts) {
        restarts++;
        await delay(options.recoveryDelayMs * 2 ** (restarts - 1), undefined, {
          signal: stopping.signal,
        });
        try {
          metadata = await initialize();
          if (!stopping.signal.aborted)
            status = outputFailure ? "unavailable" : "ready";
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          // initialize() leaves the generation in current, including failed startup.
          // Confirm cleanup before retrying; an unconfirmed process exit stops recovery.
          if (current) await retire(current);
        }
      }
      if (!stopping.signal.aborted) status = "unavailable";
    } catch (error) {
      if (!stopping.signal.aborted) {
        lastError = error instanceof Error ? error : new Error(String(error));
        status = "unavailable";
      }
    }
  }

  let metadata = await initialize();
  status = "ready";

  function submitDetection(
    request: Extract<
      z.infer<typeof taskSchema>,
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
          "Detection pool has one running and one pending task",
        ),
      );
    const rgbBytes =
      request.kind === "detect" ? request.frame.rgb.byteLength : 0;
    const imageRequest = request.kind === "detect_image";
    const outputPath = imageRequest ? request.image.outputPath : undefined;
    const output = outputPath
      ? outputs.reserve(generation, outputPath)
      : undefined;
    if (outputPath && !output)
      return Promise.reject(
        new DetectionPoolError(
          "busy",
          `Annotated image output is already reserved: ${outputPath}`,
          { outputPath },
        ),
      );
    const computation = imageRequest
      ? { ...request, stagingPath: output?.stagingPath }
      : request;
    const deadline = submitted + options.taskTimeoutMs;
    const task = (async () => {
      try {
        const result = await within(
          generation.submit(computation).then(undefined, (error: unknown) => {
            // The worker reports a known image failure only after cleanup, or
            // before creating output. Unknown failures keep the exit cleanup.
            if (error instanceof ImageProcessingError) output?.writerFailed();
            throw error;
          }),
          Math.max(0, deadline - performance.now()),
          "Detection including queue wait",
          generation.failure.signal,
        );
        if (
          !("timing" in result) ||
          (imageRequest
            ? result.kind !== "image_detected"
            : result.kind !== "detected")
        )
          throw new Error("Unexpected detection response");
        if (
          result.kind === "image_detected" &&
          result.stagedImage !== output?.stagingPath
        )
          throw new Error("Unexpected annotated image staging path");
        const acceptedAt = performance.now();
        if (acceptedAt >= deadline)
          throw new DetectionPoolError(
            "timeout",
            "Detection deadline elapsed before result acceptance",
          );
        if (current !== generation || generation.failure.signal.aborted)
          throw new DetectionPoolError(
            "unavailable",
            "Result belongs to a retired process",
          );
        // There is no await between the acceptance checks and commit(). From
        // this point a generation failure cannot revoke publication or its slot.
        const commitMs = output ? await output.commit() : 0;
        const completedAt = output ? performance.now() : acceptedAt;
        if (output && completedAt >= deadline)
          throw new DetectionPoolError(
            "output_commit_unknown",
            `Annotated image publication was not confirmed within the task deadline: ${outputPath}`,
            { outputPath },
          );
        const totalMs = completedAt - submitted;
        const annotationMs = result.timing.annotationMs + commitMs;
        const processingMs =
          result.timing.readMs +
          result.timing.decodeMs +
          annotationMs +
          result.timing.preprocessMs +
          result.timing.inferenceMs +
          result.timing.postprocessMs;
        return {
          ...result,
          annotatedImage: output?.outputPath,
          timing: {
            ...result.timing,
            annotationMs,
            totalMs,
            dispatchMs: Math.max(0, totalMs - processingMs),
          },
        };
      } catch (error) {
        if (
          error instanceof DetectionPoolError &&
          error.code === "output_commit_unknown"
        )
          throw error;
        if (error instanceof ImageProcessingError)
          throw new DetectionPoolError(error.code, error.message, {
            cause: error,
            outputPath,
          });
        if (output?.accepted) {
          outputFailure = new DetectionPoolError(
            "unavailable",
            "Annotation output cleanup failed",
            { cause: error, outputPath },
          );
          lastError = outputFailure;
          if (!stopping.signal.aborted) status = "unavailable";
          throw outputFailure;
        }
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
    void task
      .finally(() => {
        active.delete(task);
        activeRgbBytes -= rgbBytes;
        if (imageRequest) activeImageRequests--;
      })
      .catch(() => {});
    // The actual task keeps its admission slot and output reservation until an
    // accepted rename settles, even after its caller's deadline has expired.
    return within(
      task,
      Math.max(0, deadline - performance.now()),
      "Complete detection task",
      endingWaits.signal,
    ).catch((error: unknown) => {
      if (
        output?.accepted &&
        error instanceof DetectionPoolError &&
        (error.code === "timeout" ||
          error.code === "closed" ||
          error.code === "output_commit_unknown")
      ) {
        if (output.publicationError)
          throw new DetectionPoolError(
            "output_failed",
            output.publicationError.message,
            { cause: output.publicationError, outputPath },
          );
        throw new DetectionPoolError(
          "output_commit_unknown",
          `Annotated image publication was not confirmed within the task deadline: ${outputPath}`,
          { cause: error, outputPath },
        );
      }
      if (error instanceof DetectionPoolError && error.code === "timeout")
        fail(generation, error);
      throw error;
    });
  }

  async function detect(inputFrame: z.infer<typeof frameSchema>) {
    const submitted = performance.now();
    // Caller validation precedes admission and never consumes recovery budget.
    const frame = frameSchema.parse(inputFrame);
    const result = await submitDetection({ kind: "detect", frame }, submitted);
    if (result.kind !== "detected")
      throw new Error("Unexpected detection response");
    const { annotatedImage: _annotatedImage, ...detected } = result;
    return detected;
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
    const { stagedImage: _stagedImage, ...detectedImage } = result;
    return detectedImage;
  }

  function close() {
    if (closing) return closing;
    status = "closing";
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
            if (current && !current.failure.signal.aborted) {
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
          current.failure.abort(
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
            "Accepted annotation commits",
          );
          if (terminated)
            await within(
              outputs.discardStoppedOutputs(),
              Math.max(0, deadline - performance.now()),
              "Annotation output cleanup",
            );
        } catch (error) {
          terminated = false;
          const committing = outputs.committingPaths();
          shutdownError = committing.length
            ? new DetectionPoolError(
                "output_commit_unknown",
                `Shutdown could not confirm annotated image publication: ${committing.join(", ")}`,
                { cause: error, outputPath: committing[0] },
              )
            : error;
          endingWaits.abort(shutdownError);
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

  function getStatus() {
    return {
      status,
      restarts,
      lastError: lastError ? errorDetails(lastError).message : undefined,
      processId: current?.pid,
      activeRequests: active.size,
      activeRgbBytes,
      activeImageRequests,
      committingOutputs: outputs.committingPaths(),
    };
  }
  return {
    get metadata() {
      return metadata;
    },
    detect,
    detectImage,
    close,
    getStatus,
  };
}
