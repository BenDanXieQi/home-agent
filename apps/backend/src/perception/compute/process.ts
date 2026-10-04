import { setTimeout as delay } from "node:timers/promises";
import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
import type { z } from "zod";
import {
  responseSchema,
  restoreError,
  resultResponseSchema,
  commandSchema,
} from "./protocol";

import { isCurrentRun } from "../observations";
import { detectionComputeBudget } from "./budget";

// Backend main-thread ownership: all camera callers must share its pool.
// Keep the slot until OS exit, even when IPC has already disconnected.
const processes = new Set<ReturnType<typeof fork>>();

type ReceivedResult = z.infer<typeof resultResponseSchema> & {
  receivedAt: number;
};

export function createDetectionProcess(taskTimeoutMs = 10_000) {
  if (process.platform === "win32")
    throw new Error("Video compute supervision requires POSIX process groups");
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
      detached: true,
      // Parent and child run the same Bun executable; preserve Uint8Array pixels.
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, ORT_DISABLE_TELEMETRY: "1" },
    },
  );
  processes.add(child);
  const events = new EventEmitter();
  const failure = new AbortController();
  const ready = Promise.withResolvers<
    { ready: true } | { ready: false; reason: unknown }
  >();
  const exited = Promise.withResolvers<void>();
  const pending = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<ReceivedResult>>
  >();
  let nextId = 0;
  let stopped = false;
  let stderr = "";
  let terminationError: unknown;
  function watchVideoTask() {
    const deadline = performance.now() + taskTimeoutMs;
    return {
      deadline,
      timer: setTimeout(
        () => report(new Error("Video inference hard deadline exceeded")),
        taskTimeoutMs,
      ),
    };
  }
  const videoTasks = new Map<string, ReturnType<typeof watchVideoTask>>();
  function killGroup() {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ESRCH")
      )
        throw error;
    }
  }
  async function confirmGroupExit() {
    await exited.promise;
    if (child.pid === undefined) return;
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) {
      try {
        process.kill(-child.pid, 0);
        killGroup();
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ESRCH"
        ) {
          processes.delete(child);
          return;
        }
        if (
          !(error instanceof Error && "code" in error && error.code === "EPERM")
        )
          throw error;
        // macOS can transiently refuse signals while an aborted leader is exiting.
        // Keep ownership and retry confirmation; permission errors are never proof of exit.
        terminationError = error;
      }
      await delay(25);
    }
    throw new Error("Compute process group exit unconfirmed", {
      cause: terminationError,
    });
  }
  // Startup settles as a value even when no caller has submitted a request yet.
  child.stderr?.on("data", (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-4096);
  });

  // Failure owns both request rejection and termination. Exit confirmation
  // remains separate so callers cannot reuse the process budget too early.
  function abort(reason: unknown) {
    if (failure.signal.aborted) return;
    failure.abort(reason);
    ready.resolve({ ready: false, reason });
    for (const request of pending.values()) request.reject(reason);
    pending.clear();
    // Kill the isolated OS process, never a thread hosting an active N-API call.
    for (const task of videoTasks.values()) clearTimeout(task.timer);
    videoTasks.clear();
    try {
      killGroup();
    } catch (error) {
      terminationError = error;
    }
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
      ready.resolve({ ready: true });
      return;
    }
    if (response.kind === "fatal") {
      report(restoreError(response));
      return;
    }
    if (response.kind === "video") {
      const event = response.payload;
      if (event.event === "submitted") {
        const key = `${event.run.runId}:${event.sequence}`;
        if (videoTasks.has(key) || videoTasks.size >= 8) {
          report(new Error("Invalid video task admission"));
          return;
        }
        videoTasks.set(key, watchVideoTask());
      } else if (event.event === "settled") {
        const key = `${event.run.runId}:${event.sequence}`;
        if (!videoTasks.has(key)) {
          report(new Error("Unmatched video completion"));
          return;
        }
        const task = videoTasks.get(key)!;
        if (
          receivedAt >= task.deadline ||
          (event.observation &&
            (event.observation.sequence !== event.sequence ||
              !isCurrentRun(event.run, event.observation.run)))
        ) {
          report(new Error("Expired or mismatched video completion"));
          return;
        }
        clearTimeout(task.timer);
        videoTasks.delete(key);
      }
      events.emit("video", event);
      if (event.event === "window_frame" && child.connected) {
        child.send(
          {
            kind: "window_ack",
            runId: event.run.runId,
            sequence: event.frame.sequence,
          },
          (error) => {
            if (error) report(error);
          },
        );
      }
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
    exited.resolve();
    report(
      new Error(`Detection process exited (${signal ?? code}): ${stderr}`),
    );
  });
  child.on("disconnect", () => {
    if (!stopped && !failure.signal.aborted)
      report(new Error("Detection process IPC disconnected"));
  });

  async function submit(task: z.infer<typeof commandSchema>) {
    failure.signal.throwIfAborted();
    const startup = await ready.promise;
    if (!startup.ready) throw startup.reason;
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
  let destruction: Promise<void> | undefined;
  function destroy() {
    abort(new Error("Detection process terminated"));
    destruction ??= confirmGroupExit().catch((error: unknown) => {
      destruction = undefined;
      throw error;
    });
    return destruction;
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
