import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { validateJson } from "@home-agent/api/errors/hono";
import { startDeviceLogSchema } from "@home-agent/api/device-logs";
import type { DevicePushLogs } from "./device-logs";

export function createDeviceLogRoutes(logs: DevicePushLogs) {
  let connections = 0;
  return new Hono()
    .get("/", async (c) => {
      await logs.ready;
      return c.json(logs.snapshot());
    })
    .post("/capture", validateJson(startDeviceLogSchema), async (c) =>
      c.json(await logs.start(c.req.valid("json").duration_seconds)),
    )
    .delete("/capture", async (c) => c.json(await logs.stop()))
    .get("/download", async () => {
      await logs.ready;
      const { file, name } = logs.download();
      return new Response(file, {
        headers: {
          "Content-Type": "application/x-ndjson",
          "Content-Disposition": `attachment; filename="${name}"`,
          "Cache-Control": "no-store",
        },
      });
    })
    .get("/events", async (c) => {
      await logs.ready;
      if (connections >= 8) return c.body(null, 503);
      connections++;
      c.header("X-Accel-Buffering", "no");
      return streamSSE(c, async (stream) => {
        let runId: string | null | undefined;
        let cursor = 0;
        try {
          while (!stream.aborted && !stream.closed) {
            const snapshot = logs.snapshot();
            const id = snapshot.run?.id ?? null;
            const reset = id !== runId;
            const entries = reset
              ? snapshot.entries
              : snapshot.entries.filter((row) => row.sequence > cursor);
            const deadline = setTimeout(() => stream.abort(), 10_000);
            try {
              await stream.writeSSE({
                event: reset ? "snapshot" : "update",
                data: JSON.stringify({ run: snapshot.run, entries }),
              });
            } finally {
              clearTimeout(deadline);
            }
            runId = id;
            cursor = snapshot.run?.total_rows ?? 0;
            await stream.sleep(1000);
          }
        } finally {
          connections--;
        }
      });
    });
}
