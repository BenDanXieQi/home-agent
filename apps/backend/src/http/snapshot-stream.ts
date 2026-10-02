import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import pTimeout from "p-timeout";
import { addAbortListener } from "node:events";

export function createSnapshotStream(
  source: { subscribe: (listener: () => void) => () => void },
  snapshot: () => unknown,
  shutdown: AbortSignal,
) {
  let connections = 0;
  let cached: string | undefined;
  function publication() {
    if (cached !== undefined) return cached;
    const data = JSON.stringify(snapshot());
    if (Buffer.byteLength(data) > 2 * 1024 * 1024)
      throw new Error("Snapshot exceeds transport budget");
    cached = data;
    // Share this delivery batch, not a time-dependent view with future joiners.
    queueMicrotask(() => {
      cached = undefined;
    });
    return data;
  }
  return (c: Context) => {
    if (c.req.method === "HEAD")
      return c.body(null, 200, { "Content-Type": "text/event-stream" });
    if (connections >= 16 || shutdown.aborted)
      return c.json({ error: "Snapshot subscription unavailable" }, 503);
    connections++;
    return streamSSE(c, async (stream) => {
      let wake = Promise.withResolvers<void>();
      let dirty = true;
      function notify() {
        cached = undefined;
        dirty = true;
        wake.resolve();
      }
      stream.onAbort(() => {
        wake.resolve();
      });
      const unsubscribe = source.subscribe(notify);
      const stopping = addAbortListener(shutdown, () => {
        stream.abort();
      });
      const heartbeat = setInterval(() => wake.resolve(), 15000);
      try {
        while (!shutdown.aborted && !stream.aborted) {
          const data = dirty ? publication() : "{}";
          const event = dirty ? "snapshot" : "heartbeat";
          dirty = false;
          await pTimeout(stream.writeSSE({ event, data }), {
            milliseconds: 15000,
          });
          if (!dirty && !stream.aborted) await wake.promise;
          wake = Promise.withResolvers<void>();
        }
      } catch (error) {
        if (!stream.aborted)
          console.warn(
            "Snapshot subscription closed",
            error instanceof Error ? error.message : "write failed",
          );
        stream.abort();
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
        stopping[Symbol.dispose]();
        connections--;
        if (!connections) cached = undefined;
      }
    });
  };
}
