import { inferenceResponseSchema } from "./inference-protocol";
import { fork } from "node:child_process";
import pTimeout from "p-timeout";
import type { z } from "zod";

// One native inference child and one in-flight request. Model protocols and
// recovery policy belong to adapters/runtimes; process ownership lives here.
export function createInferenceProcess<
  Input extends object,
  Ready,
  Result,
>(options: {
  entry: URL;
  args?: string[];
  input: z.ZodType<Input>;
  decode: (
    message: unknown,
  ) =>
    | { kind: "ready"; value: Ready }
    | { kind: "result"; value: Result }
    | { kind: "pulse" }
    | { kind: "failed"; error: string };
  matches?: (input: Input, result: Result) => boolean;
  initializeTimeoutMs: number;
  closeTimeoutMs: number;
  heartbeatMs?: number;
  signal?: AbortSignal;
}) {
  options.signal?.throwIfAborted();
  const child = fork(options.entry, options.args ?? [], {
    execPath: process.execPath,
    execArgv: [],
    serialization: "advanced",
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    signal: options.signal,
    killSignal: "SIGKILL",
    env: { ...process.env, ORT_DISABLE_TELEMETRY: "1" },
  });
  const initialized = Promise.withResolvers<
    { value: Ready } | { error: Error }
  >();
  const exited = Promise.withResolvers<void>();
  let waiting:
    | (ReturnType<typeof Promise.withResolvers<Result>> & {
        input: Input;
        requestId: string;
      })
    | undefined;
  let ready = false,
    hasExited = false;
  let lastPulse = performance.now();
  let error: Error | undefined;
  let diagnostic = "";
  let closing: Promise<void> | undefined;
  const startup = setTimeout(
    () => fail(new Error("Inference initialization timed out")),
    options.initializeTimeoutMs,
  );
  const watchdog =
    options.heartbeatMs === undefined
      ? undefined
      : setInterval(() => {
          if (ready && performance.now() - lastPulse > options.heartbeatMs!)
            fail(new Error("Inference heartbeat expired"));
        }, 250);
  function fail(cause: unknown) {
    error ??= cause instanceof Error ? cause : new Error(String(cause));
    ready = false;
    clearTimeout(startup);
    clearInterval(watchdog);
    initialized.resolve({ error });
    waiting?.reject(error);
    waiting = undefined;
    if (!hasExited) child.kill("SIGKILL");
  }
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-4096);
  });
  child.stderr?.on("error", fail);
  child.on("error", (cause) => {
    if (child.pid === undefined) {
      hasExited = true;
      exited.resolve();
    }
    fail(cause);
  });
  child.on("exit", () => {
    hasExited = true;
    fail(new Error(diagnostic || "Inference process exited"));
    exited.resolve();
  });
  child.on("disconnect", () => fail(new Error("Inference IPC disconnected")));
  child.on("message", (message: unknown) => {
    if (error) return;
    try {
      const envelope = inferenceResponseSchema.parse(message);
      const response = options.decode(envelope.message);
      if (response.kind === "failed") throw new Error(response.error);
      lastPulse = performance.now();
      if (response.kind === "ready") {
        if (ready || envelope.requestId !== null)
          throw new Error("Duplicate or invalid inference initialization");
        ready = true;
        clearTimeout(startup);
        initialized.resolve({ value: response.value });
      } else if (response.kind === "result") {
        if (
          !ready ||
          !waiting ||
          envelope.requestId !== waiting.requestId ||
          (options.matches && !options.matches(waiting.input, response.value))
        )
          throw new Error("Unexpected inference result identity");
        const pending = waiting;
        waiting = undefined;
        pending.resolve(response.value);
      } else if (!ready)
        throw new Error("Inference heartbeat before initialization");
    } catch (cause) {
      fail(cause);
    }
  });
  return {
    get status() {
      return {
        ready,
        busy: waiting !== undefined,
        error,
        processId: child.pid,
      };
    },
    async initialize() {
      const result = await initialized.promise;
      if ("error" in result) throw result.error;
      if (error) throw error;
      return result.value;
    },
    async request(input: Input, timeoutMs: number) {
      if (error || !ready)
        throw error ?? new Error("Inference process unavailable");
      if (waiting)
        throw new Error("Inference process already has an in-flight request");
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        throw new Error("Invalid inference deadline");
      const message = options.input.parse(input);
      const pending = Promise.withResolvers<Result>();
      const requestId = crypto.randomUUID();
      waiting = { ...pending, input: message, requestId };
      const response = pTimeout(pending.promise, {
        milliseconds: timeoutMs,
        message: "Inference task timed out",
      });
      try {
        try {
          child.send({ requestId, input: message }, (cause) => {
            if (cause) fail(cause);
          });
        } catch (cause) {
          fail(cause);
        }
        return await response;
      } catch (cause) {
        fail(cause);
        throw cause;
      } finally {
        if (waiting?.promise === pending.promise) waiting = undefined;
      }
    },
    interrupt() {
      fail(new Error("Inference operation cancelled"));
    },
    close() {
      closing ??= (async () => {
        fail(new Error("Inference process closed"));
        await pTimeout(exited.promise, {
          milliseconds: options.closeTimeoutMs,
          message: "Inference process exit unconfirmed",
        });
      })().catch((cause: unknown) => {
        closing = undefined;
        throw cause;
      });
      return closing;
    },
  };
}
