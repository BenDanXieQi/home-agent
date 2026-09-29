import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { roomAnalysisQuerySchema } from "@home-agent/api/room-analysis";
import type { z } from "zod";
import type { RoomAnalysisService } from "./service";

const noop = () => {};

/** Coalesce slow viewers to one current snapshot; this is not an event journal. */
export function createRoomAnalysisStream(service: RoomAnalysisService) {
  let connections = 0;
  return (c: Context, input: z.infer<typeof roomAnalysisQuerySchema>) => {
    service.snapshot(input);
    if (connections >= 8) {
      c.header("Retry-After", "30");
      return c.body(null, 503);
    }
    connections++;
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let dirty = true;
      let heartbeat = false;
      let wake = noop;
      let previous = "";
      const unsubscribe = service.subscribe(() => {
        dirty = true;
        wake();
      });
      const close = () => {
        stream.abort();
        wake();
      };
      stream.onAbort(() => wake());
      c.req.raw.signal.addEventListener("abort", close, { once: true });
      if (c.req.raw.signal.aborted) close();
      const timer = setInterval(() => {
        heartbeat = true;
        wake();
      }, 15_000);
      timer.unref();
      try {
        while (!stream.aborted && !stream.closed) {
          if (!dirty && !heartbeat)
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          if (stream.aborted || stream.closed) break;
          let data = "";
          let event = "state";
          if (dirty) {
            dirty = false;
            try {
              data = JSON.stringify(service.snapshot(input));
            } catch {
              event = "resync";
              data = "{}";
            }
          }
          if (event === "state" && (!data || data === previous)) {
            if (!heartbeat) continue;
            event = "heartbeat";
            data = "{}";
          }
          heartbeat = false;
          const deadline = setTimeout(close, 15_000);
          try {
            await stream.writeSSE({ event, data });
          } finally {
            clearTimeout(deadline);
          }
          if (event === "resync") break;
          if (event === "state") previous = data;
        }
      } finally {
        clearInterval(timer);
        unsubscribe();
        c.req.raw.signal.removeEventListener("abort", close);
        connections--;
      }
    });
  };
}
