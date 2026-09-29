import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
import type { z } from "zod";
import {
  responseSchema,
  restoreError,
  resultResponseSchema,
  taskSchema,
} from "./protocol";

import { detectionComputeBudget } from "./budget";

// Backend main-thread ownership: all camera callers must share its pool.
// Keep the slot until OS exit, even when IPC has already disconnected.
const processes = new Set<ReturnType<typeof fork>>();

type ReceivedResult = z.infer<typeof resultResponseSchema> & {
  receivedAt: number;
};

export function createDetectionProcess() {
  if (processes.size >= detectionComputeBudget.processes)
    throw new Error(
      "Detection process budget exhausted; share the existing pool",
    );
  const child = fork(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./process-entry.ts"
        : "./perception/compute/process-entry.js",
      import.meta.url,
    ),
    [],
    {
      execPath: process.execPath,
      execArgv: [],
      // Parent and child run the same Bun executable; preserve Uint8Array pixels.
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, ORT_DISABLE_TELEMETRY: "1" },
    },
  );
  processes.add(child);
  const events = new EventEmitter();
  const failure = new AbortController();
  const ready = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  const pending = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<ReceivedResult>>
  >();
  let nextId = 0;
  let stopped = false;
  let stderr = "";
  // Startup can fail before initialize() submits its first request.
  ready.promise.catch(() => {});
  child.stderr?.on("data", (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-4096);
  });

  // Failure owns both request rejection and termination. Exit confirmation
  // remains separate so callers cannot reuse the process budget too early.
  function abort(reason: unknown) {
    if (failure.signal.aborted) return;
    failure.abort(reason);
    ready.reject(reason);
    for (const request of pending.values()) request.reject(reason);
    pending.clear();
    // Kill the isolated OS process, never a thread hosting an active N-API call.
    if (!stopped && child.pid !== undefined) child.kill("SIGKILL");
  }

  function report(error: Error) {
    if (failure.signal.aborted) return;
    abort(error);
    events.emit("error", error);
  }
  child.on("message", (message: unknown) => {
    const receivedAt = performance.now();
    if (failure.signal.aborted || stopped) return;
    const parsed = responseSchema.safeParse(message);
    if (!parsed.success) {
      report(
        new Error("Invalid detection process response", {
          cause: parsed.error,
        }),
      );
      return;
    }
    const response = parsed.data;
    if (response.kind === "ready") {
      ready.resolve();
      return;
    }
    if (response.kind === "fatal") {
      report(restoreError(response));
      return;
    }
    const request = pending.get(response.id);
    if (!request) {
      report(new Error("Unmatched detection process response"));
      return;
    }
    pending.delete(response.id);
    if (response.kind === "error") request.reject(restoreError(response));
    else request.resolve({ ...response, receivedAt });
  });
  child.on("error", (error) => {
    // A failed spawn has no process and may never emit exit.
    if (child.pid === undefined) {
      stopped = true;
      processes.delete(child);
      exited.resolve();
    }
    report(error);
  });
  child.on("exit", (code, signal) => {
    stopped = true;
    processes.delete(child);
    exited.resolve();
    report(
      new Error(`Detection process exited (${signal ?? code}): ${stderr}`),
    );
  });
  child.on("disconnect", () => {
    if (!stopped && !failure.signal.aborted)
      report(new Error("Detection process IPC disconnected"));
  });

  async function submit(task: z.infer<typeof taskSchema>) {
    failure.signal.throwIfAborted();
    await ready.promise;
    failure.signal.throwIfAborted();
    // IPC may serialize the whole backing buffer. Copy oversized views explicitly;
    // Buffer.slice() would preserve the oversized backing allocation.
    if (
      task.kind === "detect" &&
      task.frame.rgb.buffer.byteLength !== task.frame.rgb.byteLength
    ) {
      task = {
        ...task,
        frame: { ...task.frame, rgb: new Uint8Array(task.frame.rgb) },
      };
    }
    const id = ++nextId;
    const request = Promise.withResolvers<ReceivedResult>();
    pending.set(id, request);
    const sentAt = performance.now();
    try {
      child.send({ id, task }, (error: Error | null) => {
        if (error) report(error);
      });
    } catch (error) {
      report(
        error instanceof Error
          ? error
          : new Error("IPC send failed", { cause: error }),
      );
    }
    const response = await request.promise;
    const result = response.result;
    if (!("timing" in result)) return result;
    return {
      ...result,
      timing: {
        ...result.timing,
        // Only durations cross IPC; clocks in separate processes have no shared origin.
        ipcRoundTripMs: Math.max(
          0,
          response.receivedAt - sentAt - response.processingMs,
        ),
      },
    };
  }
  function destroy() {
    abort(new Error("Detection process terminated"));
    return exited.promise;
  }
  return {
    events,
    signal: failure.signal,
    abort,
    submit,
    destroy,
    pid: child.pid,
  };
}
