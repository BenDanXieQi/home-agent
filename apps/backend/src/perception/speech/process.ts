import { fork } from "node:child_process";
import pTimeout from "p-timeout";
import type { z } from "zod";
import { speechJobSchema, speechResponseSchema } from "./protocol";
import { speechLimits } from "./limits";

// This child stays in the owning audio process group. It never owns decoders.
export function createSpeechProcess() {
  const child = fork(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./process-entry.ts"
        : "../speech/process-entry.js",
      import.meta.url,
    ),
    [],
    {
      execPath: process.execPath,
      execArgv: [],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, ORT_DISABLE_TELEMETRY: "1" },
    },
  );
  const initialized = Promise.withResolvers<
    { ready: true } | { ready: false; error: Error }
  >();
  const exited = Promise.withResolvers<void>();
  let waiting:
    | (ReturnType<
        typeof Promise.withResolvers<
          z.infer<(typeof speechResponseSchema.options)[1]>
        >
      > & { id: string })
    | undefined;
  let ready = false,
    closingRequested = false,
    lastPulse = performance.now();
  let error: Error | undefined;
  let diagnostic = "";
  let rssBytes: number | null = null;
  let modelSha256: string | null = null;
  let closing: Promise<void> | undefined;
  function fail(cause: unknown) {
    if (error) return;
    error = cause instanceof Error ? cause : new Error(String(cause));
    ready = false;
    initialized.resolve({ ready: false, error });
    waiting?.reject(error);
  }
  const watchdog = setInterval(() => {
    if (ready && performance.now() - lastPulse > 5000)
      fail(new Error("Speech heartbeat expired"));
  }, 250);
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-2048);
  });
  child.on("error", (cause) => {
    fail(cause);
    if (child.pid === undefined) exited.resolve();
  });
  child.on("exit", () => {
    fail(
      new Error(
        closingRequested ? "Speech closed" : `Speech exited: ${diagnostic}`,
      ),
    );
    exited.resolve();
  });
  child.on("message", (message: unknown) => {
    if (error || closingRequested) return;
    const parsed = speechResponseSchema.safeParse(message);
    if (!parsed.success) {
      fail(parsed.error);
      return;
    }
    const result = parsed.data;
    if (result.kind === "fatal") {
      fail(new Error(result.error));
      return;
    }
    lastPulse = performance.now();
    rssBytes = result.rssBytes;
    if (result.kind === "ready") {
      ready = true;
      modelSha256 = result.modelSha256;
      initialized.resolve({ ready: true });
    } else if (result.kind === "result") {
      if (waiting?.id === result.id) waiting.resolve(result);
      else fail(new Error("Speech result identity mismatch"));
    }
  });
  return {
    get status() {
      return { ready, error, processId: child.pid, rssBytes, modelSha256 };
    },
    async initialize() {
      const result = await pTimeout(initialized.promise, {
        milliseconds: speechLimits.initializeTimeoutMs,
      });
      if (!result.ready) throw result.error;
    },
    async recognize(input: z.infer<typeof speechJobSchema>) {
      if (!ready || error || closingRequested)
        throw error ?? new Error("Speech process unavailable");
      if (waiting)
        throw new Error("Speech process already has an in-flight request");
      const job = speechJobSchema.parse(input);
      const pending =
        Promise.withResolvers<
          z.infer<(typeof speechResponseSchema.options)[1]>
        >();
      waiting = { id: job.id, ...pending };
      try {
        child.send(job, (cause) => {
          if (cause) fail(cause);
        });
        return await pTimeout(pending.promise, {
          milliseconds: speechLimits.inferenceTimeoutMs,
          message: "Speech inference deadline exceeded",
        });
      } finally {
        waiting = undefined;
      }
    },
    interrupt() {
      closingRequested = true;
      fail(new Error("Speech operation cancelled"));
      child.kill("SIGKILL");
    },
    close() {
      closingRequested = true;
      ready = false;
      clearInterval(watchdog);
      closing ??= (async () => {
        fail(new Error("Speech closed"));
        child.kill("SIGKILL");
        await pTimeout(exited.promise, {
          milliseconds: speechLimits.closeTimeoutMs,
          message: "Speech process exit unconfirmed",
        });
      })().catch((cause: unknown) => {
        closing = undefined;
        throw cause;
      });
      return closing;
    },
  };
}
