import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  createDetectionPool,
  DetectionPoolError,
} from "../src/perception/compute/pool";
import { createPerceptionReport } from "./perception-report";

// Frame slots follow wall-clock time. A late callback only offers the latest
// due frame; older slots are counted as missed rather than emitted as a burst.
export function createFrameSchedule(fps: number, durationMs: number) {
  const planned = Math.floor((durationMs * fps) / 1000);
  let accounted = 0;
  let offered = 0;
  let missedDueToEventLoop = 0;
  function finish() {
    missedDueToEventLoop += planned - accounted;
    accounted = planned;
    return { planned, offered, missedDueToEventLoop };
  }
  function takeDue(elapsedMs: number) {
    if (elapsedMs >= durationMs) {
      finish();
      return false;
    }
    const due = Math.min(planned, Math.floor((elapsedMs * fps) / 1000) + 1);
    if (due <= accounted) return false;
    missedDueToEventLoop += due - accounted - 1;
    accounted = due;
    offered++;
    return true;
  }
  function nextDelayMs(elapsedMs: number) {
    if (accounted < planned)
      return Math.max(1, Math.ceil((accounted * 1000) / fps - elapsedMs));
    return undefined;
  }
  return { takeDue, nextDelayMs, finish };
}

function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[
      Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
    ] ?? 0;
  return {
    samples: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1) ?? 0,
  };
}

async function main() {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { seconds: { type: "string", default: "20" } },
  });
  const [image] = positionals;
  if (!image || positionals.length !== 1)
    throw new Error("Usage: benchmark-detection [--seconds 20] <image>");
  const seconds = z.coerce.number().int().min(5).max(300).parse(values.seconds);
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("RSS sampling requires macOS or Linux ps");
  const execute = promisify(execFile);
  const pool = await createDetectionPool();
  let inputSha256: string | undefined;
  try {
    for (const [width, height, fps] of [
      [1920, 1080, 10],
      [3840, 2160, 10],
      [3840, 2160, 30],
    ] as const) {
      const task = { path: resolve(image), resize: { width, height } };
      async function detectImage() {
        const result = await pool.detectImage(task);
        inputSha256 ??= result.inputSha256;
        if (result.inputSha256 !== inputSha256)
          throw new Error("Input image changed during the benchmark");
        return result;
      }
      const reference = await detectImage();
      for (let i = 1; i < 5; i++) await detectImage();
      const timing: Awaited<ReturnType<typeof detectImage>>["timing"][] = [];
      const timerLag: number[] = [];
      const memory: {
        parentMiB: number;
        childMiB: number;
        totalMiB: number;
      }[] = [];
      const errors: string[] = [];
      let busy = 0;
      let sampling = false;
      let sampleError: string | undefined;
      const pending = new Set<Promise<void>>();
      const started = performance.now();
      const durationMs = seconds * 1000;
      const schedule = createFrameSchedule(fps, durationMs);
      let lastTick = started;
      const responsiveness = setInterval(() => {
        const now = performance.now();
        timerLag.push(Math.max(0, now - lastTick - 10));
        lastTick = now;
      }, 10);
      async function sampleMemory() {
        if (sampling) return;
        sampling = true;
        try {
          const { stdout } = await execute(
            "ps",
            ["-o", "rss=", "-p", String(pool.getStatus().processId)],
            { timeout: 1000 },
          );
          const childMiB =
            z.coerce.number().positive().parse(stdout.trim()) / 1024;
          const parentMiB = process.memoryUsage().rss / 1048576;
          memory.push({ parentMiB, childMiB, totalMiB: parentMiB + childMiB });
        } catch (error) {
          sampleError = String(error);
        } finally {
          sampling = false;
        }
      }
      let samplePending: Promise<void> | undefined;
      const memoryTimer = setInterval(() => {
        if (!sampling) samplePending = sampleMemory();
      }, 250);
      let producer: ReturnType<typeof setTimeout> | undefined;
      function produce() {
        if (schedule.takeDue(performance.now() - started)) {
          const pendingTask = detectImage().then(
            (result) => {
              timing.push(result.timing);
            },
            (error: unknown) => {
              if (error instanceof DetectionPoolError && error.code === "busy")
                busy++;
              else errors.push(String(error));
            },
          );
          pending.add(pendingTask);
          pendingTask
            .finally(() => pending.delete(pendingTask))
            .catch((backgroundError: unknown) => {
              console.error(
                "benchmark-detection: pendingTask.finally failed",
                backgroundError,
              );
            });
        }
        const nextDelay = schedule.nextDelayMs(performance.now() - started);
        if (nextDelay !== undefined) producer = setTimeout(produce, nextDelay);
      }
      produce();
      try {
        await delay(Math.max(0, durationMs - (performance.now() - started)));
      } finally {
        clearTimeout(producer);
        await Promise.all(pending);
        clearInterval(responsiveness);
        clearInterval(memoryTimer);
        await samplePending;
      }
      const delivery = schedule.finish();
      const elapsedSeconds = (performance.now() - started) / 1000;
      const mean = (rows: typeof memory) =>
        rows.reduce((sum, row) => sum + row.totalMiB, 0) /
        Math.max(1, rows.length);
      console.log(
        JSON.stringify({
          ...(await createPerceptionReport(pool.metadata)),
          workload: {
            kind: "image-file",
            width,
            height,
            targetFps: fps,
            seconds,
            input: reference.imagePath,
            inputSha256: reference.inputSha256,
            resize: { width, height, fit: "fill", kernel: "lanczos3" },
            latencyScope: "read-hash-decode-resize-detect",
            warmupFrames: 5,
          },
          ...delivery,
          completed: timing.length,
          busy,
          errors,
          completedFps: timing.length / elapsedSeconds,
          latencyMs: distribution(timing.map((t) => t.totalMs)),
          dispatchMs: distribution(timing.map((t) => t.dispatchMs)),
          queueMs: distribution(timing.map((t) => t.queueMs)),
          ipcRoundTripMs: distribution(timing.map((t) => t.ipcRoundTripMs)),
          workerDispatchMs: distribution(timing.map((t) => t.workerDispatchMs)),
          readMs: distribution(timing.map((t) => t.readMs)),
          decodeMs: distribution(timing.map((t) => t.decodeMs)),
          preprocessMs: distribution(timing.map((t) => t.preprocessMs)),
          inferenceMs: distribution(timing.map((t) => t.inferenceMs)),
          postprocessMs: distribution(timing.map((t) => t.postprocessMs)),
          mainTimerDelayMs: distribution(timerLag),
          memory: {
            sampleIntervalMs: 250,
            sampleError,
            parentMiB: distribution(memory.map((m) => m.parentMiB)),
            childMiB: distribution(memory.map((m) => m.childMiB)),
            combinedMiB: distribution(memory.map((m) => m.totalMiB)),
            firstQuarterMeanMiB: mean(
              memory.slice(0, Math.ceil(memory.length / 4)),
            ),
            lastQuarterMeanMiB: mean(
              memory.slice(-Math.ceil(memory.length / 4)),
            ),
          },
          status: pool.getStatus(),
        }),
      );
      if (errors.length || sampleError)
        throw new Error("Benchmark encountered errors; inspect the report");
    }
  } finally {
    await pool.close();
  }
}

if (import.meta.main) await main();
