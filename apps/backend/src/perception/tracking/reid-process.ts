import { fork } from "node:child_process";
import type { z } from "zod";
import { reidResponseSchema, type reidRequestSchema } from "./reid-protocol";

// This child inherits the compute process group; outer hard shutdown owns the tree.
// ReID failures kill only this child, never the detector or a live native JS thread.
export function createReidProcess() {
  let child: ReturnType<typeof fork> | undefined;
  let ready = false;
  let stopped = false;
  let error: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: ReturnType<typeof Promise.withResolvers<number[][]>> | undefined;
  const exited = Promise.withResolvers<void>();
  function fail(reason: unknown) {
    error = String(reason).slice(0, 4096);
    ready = false;
    clearTimeout(timer);
    request?.reject(new Error(error));
    request = undefined;
    if (
      child?.pid !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    )
      child.kill("SIGKILL");
  }
  function start() {
    if (child || stopped) return;
    child = fork(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "./reid-entry.ts"
          : "../tracking/reid-entry.js",
        import.meta.url,
      ),
      [],
      {
        execPath: process.execPath,
        execArgv: [],
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...process.env, ORT_DISABLE_TELEMETRY: "1" },
      },
    );
    timer = setTimeout(() => fail("ReID initialization timed out"), 30000);
    child.on("message", (message: unknown) => {
      if (stopped || error) return;
      const parsed = reidResponseSchema.safeParse(message);
      if (!parsed.success) {
        fail(parsed.error);
        return;
      }
      const response = parsed.data;
      if (response.kind === "failed") {
        fail(response.error);
        return;
      }
      clearTimeout(timer);
      if (response.kind === "ready") {
        ready = true;
        return;
      }
      if (!request) {
        fail("Unexpected ReID result");
        return;
      }
      request.resolve(response.features);
      request = undefined;
    });
    child.on("error", (cause) => {
      fail(cause);
      if (child?.pid === undefined) exited.resolve();
    });
    child.on("exit", () => {
      fail(error ?? "ReID process exited");
      exited.resolve();
    });
    child.on("disconnect", () => {
      if (!stopped) fail("ReID disconnected");
    });
  }
  return {
    start,
    get status() {
      return { ready, busy: !!request, error, pid: child?.pid };
    },
    extract(input: z.infer<typeof reidRequestSchema>, timeoutMs: number) {
      if (!ready || request || stopped || !child)
        return Promise.reject(new Error(error ?? "ReID unavailable"));
      const pending = Promise.withResolvers<number[][]>();
      request = pending;
      timer = setTimeout(() => fail("ReID task timed out"), timeoutMs);
      try {
        child.send(input, (cause) => {
          if (cause) fail(cause);
        });
      } catch (cause) {
        fail(cause);
      }
      return pending.promise;
    },
    async close() {
      stopped = true;
      fail("ReID closed");
      if (child) {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            exited.promise,
            new Promise<never>((_, reject) => {
              deadline = setTimeout(
                () => reject(new Error("ReID exit unconfirmed")),
                3000,
              );
            }),
          ]);
        } finally {
          clearTimeout(deadline);
        }
      }
    },
  };
}
