import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readLimitedBytes } from "@home-agent/api/http/read-body";
import pTimeout from "p-timeout";
import { MediaCleanupError } from "./resources";

export async function runFfmpeg(
  executable: string,
  args: string[],
  signal: AbortSignal,
  maxBuffer: number,
) {
  const task = createFfmpegProcess(
    executable,
    args,
    signal,
    async (stdout, scoped) =>
      readLimitedBytes({ body: Readable.toWeb(stdout) }, maxBuffer, scoped),
    { maxStderrBytes: maxBuffer },
  );
  return new TextDecoder().decode(await task.completed);
}

export function createFfmpegProcess<T>(
  executable: string,
  args: string[],
  signal: AbortSignal,
  consume: (stdout: Readable, signal: AbortSignal) => Promise<T>,
  options: {
    liveInput?: ReadableStream<Uint8Array>;
    maxStderrBytes?: number;
  } = {},
) {
  signal.throwIfAborted();
  const cancelled = new AbortController();
  const scoped = AbortSignal.any([signal, cancelled.signal]);
  const child = spawn(
    executable,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-threads",
      "1",
      ...args,
    ],
    {
      stdio: [options.liveInput ? "pipe" : "ignore", "pipe", "pipe"],
      signal: scoped,
      killSignal: "SIGKILL",
      windowsHide: true,
    },
  );
  const completion = Promise.withResolvers<void>();
  const closed = new Promise<void>((resolve) => {
    child.once("close", resolve);
  });
  let stderr = "";
  let stderrBytes = 0;
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(options.liveInput ? -2048 : -16_384);
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > (options.maxStderrBytes ?? Infinity))
      cancelled.abort(new Error("Media process stderr exceeds its buffer"));
  });
  child.once("error", completion.reject);
  child.once("exit", (code) => {
    if (scoped.aborted) completion.reject(scoped.reason);
    else if (code === 0 && !options.liveInput) completion.resolve();
    else
      completion.reject(new Error(`Media process failed (${code}): ${stderr}`));
  });
  const consuming = Promise.resolve().then(() =>
    consume(child.stdout!, scoped),
  );
  const feeding = options.liveInput
    ? pipeline(Readable.fromWeb(options.liveInput), child.stdin!, {
        signal: scoped,
      }).then(() => {
        throw new Error("Live media input ended");
      })
    : undefined;
  function close() {
    cancelled.abort();
    child.stdin?.destroy();
    child.stdout!.destroy();
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    return pTimeout(Promise.allSettled([closed, consuming, feeding]), {
      milliseconds: 3000,
      message: new MediaCleanupError(
        "Media process or I/O cleanup unconfirmed",
      ),
    });
  }
  const completed = (async () => {
    try {
      const [, result] = await Promise.all([
        completion.promise,
        consuming,
        feeding,
      ]);
      scoped.throwIfAborted();
      return result;
    } catch (cause) {
      cancelled.abort(cause);
      throw cause;
    } finally {
      await close();
    }
  })();
  return { completed, close };
}
