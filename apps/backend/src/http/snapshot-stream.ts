import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { addAbortListener } from "node:events";
import { createSseTransport } from "./sse-transport";

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
      const transport = createSseTransport(stream, {
        signal: AbortSignal.any([shutdown, c.req.raw.signal]),
        writeTimeoutMs: 15000,
        eventBytes: 2 * 1024 * 1024 + 128,
        queuedBytes: 2 * 1024 * 1024 + 128,
        queuedEvents: 1,
      });
      let wake = Promise.withResolvers<void>();
      let dirty = true;
      function notify() {
        cached = undefined;
        dirty = true;
        wake.resolve();
      }
      const stopping = addAbortListener(transport.signal, () => {
        wake.resolve();
      });
      const unsubscribe = source.subscribe(notify);
      const heartbeat = setInterval(() => wake.resolve(), 15000);
      try {
        while (!transport.closed) {
          const data = dirty ? publication() : "{}";
          const event = dirty ? "snapshot" : "heartbeat";
          dirty = false;
          await transport.send({ event, data });
          if (!dirty && !transport.closed) await wake.promise;
          wake = Promise.withResolvers<void>();
        }
      } catch (error) {
        if (
          !shutdown.aborted &&
          !(error instanceof DOMException && error.name === "AbortError")
        )
          console.warn(
            "Snapshot subscription closed",
            error instanceof Error ? error.message : "write failed",
          );
      } finally {
        transport.close();
        clearInterval(heartbeat);
        unsubscribe();
        stopping[Symbol.dispose]();
        connections--;
        if (!connections) cached = undefined;
      }
    });
  };
}
