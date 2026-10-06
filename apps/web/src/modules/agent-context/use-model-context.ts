import { useEffect, useState } from "react";
import type { compressModelContext } from "./model-context.worker";

export function useModelContext(
  snapshot: Parameters<typeof compressModelContext>[0] | undefined,
  enabled: boolean,
  readAt: number,
) {
  const [completed, setCompleted] = useState<{
    snapshot: typeof snapshot;
    readAt: number;
    result: ReturnType<typeof compressModelContext>;
  } | null>(null);
  useEffect(() => {
    if (
      !enabled ||
      !snapshot ||
      (completed?.snapshot === snapshot && completed.readAt === readAt)
    )
      return undefined;
    let worker: Worker | undefined;
    let cancelled = false;
    function failed(message: string) {
      if (cancelled) return;
      console.error("Model context worker failed", message);
      setCompleted({
        snapshot,
        readAt,
        result: { status: "failed", reason: "conversion_failed", message },
      });
    }
    try {
      worker = new Worker(
        new URL("./model-context.worker.ts", import.meta.url),
        { type: "module" },
      );
      worker.addEventListener(
        "message",
        (event: MessageEvent<ReturnType<typeof compressModelContext>>) => {
          if (cancelled) return;
          worker?.terminate();
          setCompleted({ snapshot, readAt, result: event.data });
        },
        { once: true },
      );
      worker.addEventListener(
        "error",
        (event) => {
          worker?.terminate();
          failed(event.message || "Worker execution failed");
        },
        { once: true },
      );
      worker.addEventListener(
        "messageerror",
        () => {
          worker?.terminate();
          failed("Worker response could not be read");
        },
        { once: true },
      );
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Dedicated worker messaging has no targetOrigin.
      worker.postMessage(snapshot);
    } catch (error) {
      worker?.terminate();
      failed(error instanceof Error ? error.message : String(error));
    }
    return () => {
      cancelled = true;
      worker?.terminate();
    };
  }, [enabled, snapshot, readAt, completed]);
  return snapshot &&
    completed?.snapshot === snapshot &&
    completed.readAt === readAt
    ? completed.result
    : null;
}
