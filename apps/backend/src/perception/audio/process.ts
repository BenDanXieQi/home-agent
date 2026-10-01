import { fork } from "node:child_process";
import pTimeout from "p-timeout";
import { audioResponseSchema } from "./protocol";
import type { audioCommandSchema, audioStartSchema } from "./protocol";
import type {
  audioTrackSchema,
  speechRuntimeSchema,
  speechObservationSchema,
} from "@home-agent/api/contracts";
import type { z } from "zod";

// One additional native process owns every audio decoder and a single VAD CPU thread.
export function createAudioProcess(options: {
  track: (track: z.infer<typeof audioTrackSchema>) => void;
  failure: (error: string) => void;
  speech?: (observation: z.infer<typeof speechObservationSchema>) => boolean;
}) {
  if (process.platform === "win32")
    throw new Error("Audio supervision requires POSIX process groups");
  const child = fork(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./process-entry.ts"
        : "./perception/audio/process-entry.js",
      import.meta.url,
    ),
    [],
    {
      execPath: process.execPath,
      execArgv: [],
      detached: true,
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, ORT_DISABLE_TELEMETRY: "1" },
    },
  );
  let ready = false,
    stopped = false,
    closingRequested = false;
  let error: string | undefined;
  let model: z.infer<(typeof audioResponseSchema.options)[0]>["model"] = null;
  let speech: z.infer<typeof speechRuntimeSchema> | undefined;
  let lastPulse = performance.now(),
    inferenceSince: number | null = null;
  let diagnostic = "";
  const exited = Promise.withResolvers<void>();
  const initialized = Promise.withResolvers<void>();
  const waiting = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  const closed = Promise.withResolvers<void>();
  let closing: Promise<void> | undefined;
  let groupKilled = false;
  function kill() {
    if (child.pid === undefined || groupKilled) return null;
    try {
      process.kill(-child.pid, "SIGKILL");
      groupKilled = true;
      return null;
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") {
        groupKilled = true;
        return null;
      }
      return new Error(
        `Audio process-group cleanup failed: ${String(cause)}`.slice(0, 4096),
      );
    }
  }
  function fail(cause: unknown) {
    if (error || stopped) return;
    error = String(cause).slice(0, 4096);
    ready = false;
    clearInterval(watchdogTimer);
    initialized.reject(new Error(error));
    for (const pending of waiting.values()) pending.reject(new Error(error));
    waiting.clear();
    const cleanupError = kill();
    if (cleanupError) error = cleanupError.message;
    options.failure(error);
  }
  function send(command: z.infer<typeof audioCommandSchema>) {
    if (
      stopped ||
      error ||
      !child.connected ||
      (closingRequested && command.kind !== "close")
    )
      throw new Error(error ?? "Audio process unavailable");
    child.send(command, (cause) => {
      if (cause) fail(cause);
    });
  }
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-2048);
  });
  child.on("message", (message: unknown) => {
    if (stopped || error) return;
    const parsed = audioResponseSchema.safeParse(message);
    if (!parsed.success) {
      fail(parsed.error);
      return;
    }
    const response = parsed.data;
    if (response.kind === "ready") {
      ready = true;
      model = response.model;
      lastPulse = performance.now();
      initialized.resolve();
    } else if (response.kind === "pulse") {
      lastPulse = performance.now();
      inferenceSince = response.inferenceSince;
      speech = response.speech;
    } else if (response.kind === "track") options.track(response.track);
    else if (response.kind === "speech") {
      if (!closingRequested) {
        try {
          send({
            kind: "speech_ack",
            id: response.observation.id,
            accepted: options.speech?.(response.observation) ?? false,
          });
        } catch (cause) {
          fail(cause);
        }
      }
    } else if (response.kind === "stopped") {
      waiting.get(response.trackRunId)?.resolve();
      waiting.delete(response.trackRunId);
    } else if (response.kind === "closed") closed.resolve();
    else if (response.kind === "fatal") fail(response.error);
  });
  child.on("error", (cause) => {
    fail(cause);
    if (child.pid === undefined) exited.resolve();
  });
  child.on("exit", () => {
    if (!closingRequested) fail(diagnostic || "Audio process exited");
    exited.resolve();
  });
  child.on("disconnect", () => {
    if (!closingRequested) fail("Audio process disconnected");
  });
  const watchdogTimer = setInterval(() => {
    if (
      performance.now() - lastPulse > (ready ? 5000 : 30000) ||
      (inferenceSince !== null && Date.now() - inferenceSince > 2000)
    )
      fail("Audio native processing deadline exceeded");
  }, 100);
  // The service owns startup failure and recovery; suppress no errors in its callback.
  initialized.promise.catch((cause) => {
    if (!error && !stopped && !closingRequested) fail(cause);
  });
  return {
    get status() {
      return { ready, error, model, processId: child.pid, speech };
    },
    async start(input: z.infer<typeof audioStartSchema>, signal: AbortSignal) {
      if (closingRequested) throw new Error("Audio closing");
      await pTimeout(initialized.promise, { milliseconds: 30000, signal });
      signal.throwIfAborted();
      send({ kind: "start", input });
    },
    retrySpeech() {
      if (ready && !error && !closingRequested) send({ kind: "retry_speech" });
    },
    async stop(trackRunId: string) {
      if (error || stopped || closingRequested) return;
      const pending = Promise.withResolvers<void>();
      waiting.set(trackRunId, pending);
      send({ kind: "stop", trackRunId });
      try {
        await pTimeout(pending.promise, {
          milliseconds: 5000,
          message: "Audio track cleanup timed out",
        });
      } catch (cause) {
        fail(cause);
        throw cause;
      } finally {
        waiting.delete(trackRunId);
      }
    },
    close() {
      closingRequested = true;
      closing ??= (async () => {
        clearInterval(watchdogTimer);
        initialized.reject(new Error("Audio closed"));
        if (!error && child.connected && ready) {
          try {
            send({ kind: "close" });
            await pTimeout(closed.promise, { milliseconds: 5000 });
          } catch (cause) {
            error = String(cause).slice(0, 4096);
          }
        }
        stopped = true;
        ready = false;
        for (const pending of waiting.values())
          pending.reject(new Error("Audio closed"));
        waiting.clear();
        const cleanupError = kill();
        if (cleanupError) throw cleanupError;
        await pTimeout(exited.promise, {
          milliseconds: 3000,
          message: "Audio process exit unconfirmed",
        });
      })().catch((cause: unknown) => {
        closing = undefined;
        throw cause;
      });
      return closing;
    },
  };
}
