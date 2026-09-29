import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import pTimeout from "p-timeout";
import type { createPerceptionService } from "./service";

export function createPerceptionStream(
  service: ReturnType<typeof createPerceptionService>,
  snapshot: () => unknown,
  shutdown: AbortSignal,
) {
  let connections = 0;
  return (c: Context) => {
    if (c.req.method === "HEAD")
      return c.body(null, 200, { "Content-Type": "text/event-stream" });
    if (connections >= 16 || shutdown.aborted)
      return c.json({ error: "Perception subscription unavailable" }, 503);
    connections++;
    return streamSSE(c, async (stream) => {
      let wake = Promise.withResolvers<void>();
      let dirty = true;
      let ended = false;
      function notify() {
        dirty = true;
        wake.resolve();
      }
      function stop() {
        ended = true;
        wake.resolve();
        stream.abort();
      }
      stream.onAbort(() => {
        ended = true;
        wake.resolve();
      });
      const unsubscribe = service.subscribe(notify);
      shutdown.addEventListener("abort", stop, { once: true });
      const heartbeat = setInterval(() => wake.resolve(), 15000);
      try {
        while (!shutdown.aborted) {
          if (ended) break;
          const data = dirty ? JSON.stringify(snapshot()) : "{}";
          const event = dirty ? "snapshot" : "heartbeat";
          dirty = false;
          if (Buffer.byteLength(data) > 2 * 1024 * 1024)
            throw new Error("Perception snapshot exceeds transport budget");
          await pTimeout(stream.writeSSE({ event, data }), {
            milliseconds: 15000,
          });
          if (!dirty && !ended) await wake.promise;
          wake = Promise.withResolvers<void>();
        }
      } catch (error) {
        if (!ended)
          console.warn(
            "Perception subscription closed",
            error instanceof Error ? error.message : "write failed",
          );
        stream.abort();
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
        shutdown.removeEventListener("abort", stop);
        connections--;
      }
    });
  };
}
