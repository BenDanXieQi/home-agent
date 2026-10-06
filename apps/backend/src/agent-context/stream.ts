import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { addAbortListener } from "node:events";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import {
  agentContextPolicy,
  agentContextPartsSchema,
  type agentContextSnapshotSchema,
} from "@home-agent/api/agent-context";
import { createSseTransport } from "../http/sse-transport";
import type { createAgentContextService } from "./service";
import { prepareAgentContextDelivery } from "./delivery";

export function createAgentContextStream(
  service: ReturnType<typeof createAgentContextService>,
  shutdown: AbortSignal,
) {
  let connections = 0;
  return (c: Context) => {
    if (c.req.method === "HEAD")
      return c.body(null, 200, { "Content-Type": "text/event-stream" });
    if (shutdown.aborted || connections >= agentContextPolicy.connections)
      return c.json({ error: "Context subscription unavailable" }, 503);
    connections++;
    c.header("Cache-Control", "no-store");
    return streamSSE(c, async (stream) => {
      const transport = createSseTransport(stream, {
        signal: AbortSignal.any([shutdown, c.req.raw.signal]),
        writeTimeoutMs: agentContextPolicy.writeTimeoutMs,
        eventBytes: agentContextPolicy.eventBytes,
        queuedBytes: agentContextPolicy.pendingBytes + 128,
        queuedEvents: 1,
      });
      let wake = Promise.withResolvers<void>();
      let dirty = true;
      let first = true;
      let seen = service.revisions();
      let deliveredSnapshot:
        | z.infer<typeof agentContextSnapshotSchema>
        | undefined;
      let pendingClear:
        | {
            snapshot: z.infer<typeof agentContextSnapshotSchema>;
            revisions: typeof seen;
          }
        | undefined;
      function notify(snapshot: z.infer<typeof agentContextSnapshotSchema>) {
        // A reset is a required delivery barrier even if fresh reads finish quickly.
        if (
          Object.keys(snapshot.parts).length ===
            agentContextPartsSchema.keyof().options.length &&
          Object.values(snapshot.parts).every((part) => part?.data === null)
        )
          pendingClear = { snapshot, revisions: service.revisions() };
        dirty = true;
        wake.resolve();
      }
      const release = service.subscribe(notify);
      const stopping = addAbortListener(transport.signal, () => {
        wake.resolve();
      });
      const heartbeat = setInterval(() => {
        wake.resolve();
      }, agentContextPolicy.heartbeatMs);
      try {
        while (!transport.closed) {
          let snapshot: z.infer<typeof agentContextSnapshotSchema> | undefined;
          const current = service.snapshot();
          const revisions = service.revisions();
          let delivered = revisions;
          if (pendingClear) {
            snapshot = pendingClear.snapshot;
            delivered = pendingClear.revisions;
            pendingClear = undefined;
            // A later reset replaces this obsolete barrier before delivery.
            if (!isDeepStrictEqual(snapshot.scope, current.scope)) continue;
          } else if (first) snapshot = current;
          else if (dirty) {
            const parts: z.infer<typeof agentContextSnapshotSchema>["parts"] =
              {};
            for (const key of agentContextPartsSchema.keyof().options) {
              if (revisions[key] !== seen[key])
                Object.assign(parts, { [key]: current.parts[key] });
            }
            if (Object.keys(parts).length)
              snapshot = { scope: current.scope, parts };
          }
          first = false;
          dirty = false;
          const data = snapshot
            ? (prepareAgentContextDelivery(
                deliveredSnapshot,
                snapshot,
                service.publicationBytes(snapshot),
              ) ?? service.serialize(snapshot))
            : "{}";
          if (
            snapshot &&
            Buffer.byteLength(data) > agentContextPolicy.maxSnapshotBytes
          )
            throw new Error("Context exceeds transport budget");
          await transport.send(
            snapshot
              ? { event: "snapshot", data }
              : { event: "heartbeat", data: "{}" },
          );
          seen = delivered;
          if (snapshot)
            deliveredSnapshot = {
              scope: snapshot.scope,
              parts: {
                ...(isDeepStrictEqual(deliveredSnapshot?.scope, snapshot.scope)
                  ? deliveredSnapshot?.parts
                  : {}),
                ...snapshot.parts,
              },
            };
          // A clear barrier may precede values already committed before this write.
          dirty ||=
            pendingClear !== undefined ||
            !isDeepStrictEqual(seen, service.revisions());
          if (!dirty && !transport.closed) await wake.promise;
          wake = Promise.withResolvers<void>();
          if (pendingClear || !isDeepStrictEqual(seen, service.revisions()))
            dirty = true;
        }
      } catch {
        if (!shutdown.aborted && !transport.signal.aborted)
          console.warn("Agent context stream closed");
      } finally {
        transport.close();
        release();
        stopping[Symbol.dispose]();
        clearInterval(heartbeat);
        connections--;
      }
    });
  };
}
