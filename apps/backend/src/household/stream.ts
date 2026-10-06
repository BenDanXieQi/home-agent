import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import { resyncSchema, stateVersionSchema } from "@home-agent/api/household";
import { addAbortListener } from "node:events";
import { createSseTransport } from "../http/sse-transport";
import { householdLimits } from "./config";
import type { HouseholdRuntime } from "./runtime";

const noop = () => {};

function serialize(
  event: "snapshot" | "state_change" | "heartbeat" | "resync_required",
  payload: unknown,
  end = false,
) {
  return {
    message: { event, data: JSON.stringify(payload) },
    snapshot: event === "snapshot",
    end,
  };
}
export function createHouseholdStream(runtime: HouseholdRuntime) {
  let connections = 0;
  let cached: ReturnType<typeof prepare> | undefined;
  function prepare(snapshot: ReturnType<HouseholdRuntime["snapshot"]>) {
    const { scope_epoch, sequence } = snapshot;
    const version = { scope_epoch, sequence };
    const changes = runtime.changes();
    const stopping =
      snapshot.projection.household.household.status === "stopping";
    let snapshotFrame: ReturnType<typeof serialize> | undefined;
    let changeFrame: ReturnType<typeof serialize> | undefined;
    let heartbeatFrame: ReturnType<typeof serialize> | undefined;
    let resyncFrame: ReturnType<typeof serialize> | undefined;
    return {
      version,
      stopping,
      snapshot: () => (snapshotFrame ??= serialize("snapshot", snapshot)),
      change: () => {
        if (!changes.length) return undefined;
        // Runtime commits already validate and freeze every change record.
        return (changeFrame ??= serialize("state_change", {
          ...version,
          changes,
        }));
      },
      heartbeat: () =>
        (heartbeatFrame ??= serialize(
          "heartbeat",
          stateVersionSchema.parse(version),
        )),
      resync: () =>
        (resyncFrame ??= serialize(
          "resync_required",
          resyncSchema.parse({
            ...version,
            reason: stopping ? "stopping" : "scope_changed",
          }),
          true,
        )),
    };
  }
  function current() {
    const snapshot = runtime.snapshot();
    if (
      !cached ||
      cached.version.scope_epoch !== snapshot.scope_epoch ||
      cached.version.sequence !== snapshot.sequence
    )
      cached = prepare(snapshot);
    return cached;
  }
  return (c: Context) => {
    // Hono dispatches HEAD through GET, then discards the body without cancelling it.
    if (c.req.method === "HEAD")
      return c.body(null, 200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
    if (connections >= householdLimits.connections) {
      c.header("Retry-After", "30");
      return c.body(null, 503);
    }
    connections++;
    c.header("X-Accel-Buffering", "no");
    const response = streamSSE(c, async (stream) => {
      const transport = createSseTransport(stream, {
        signal: c.req.raw.signal,
        eventBytes: householdLimits.snapshotBytes,
        queuedBytes: householdLimits.changesBytes,
        queuedEvents: householdLimits.queuedChanges,
        heartbeat: {
          intervalMs: householdLimits.heartbeatMs,
          message: () => current().heartbeat().message,
        },
        writeTimeoutMs: householdLimits.writeTimeoutMs,
      });
      let last: ReturnType<typeof current>["version"] | undefined;
      let detach = noop;
      let released = false;
      function release() {
        if (released) return;
        released = true;
        connections--;
        detach();
      }
      const aborted = addAbortListener(transport.signal, release);
      function enqueue(item: ReturnType<typeof serialize>) {
        transport.enqueue(item.message, {
          queued: !item.snapshot,
          end: item.end,
        });
      }
      try {
        // No await between registration and the single committed snapshot.
        detach = runtime.subscribe(() => {
          const next = current();
          if (
            last?.scope_epoch === next.version.scope_epoch &&
            last.sequence === next.version.sequence
          )
            return;
          if (
            !last ||
            next.version.scope_epoch !== last.scope_epoch ||
            next.stopping
          ) {
            enqueue(next.resync());
          } else if (next.version.sequence > last.sequence) {
            const change = next.change();
            if (change) enqueue(change);
          }
          last = next.version;
        });
        const initial = current();
        last = initial.version;
        enqueue(initial.snapshot());
        await transport.done;
      } finally {
        transport.close();
        release();
        aborted[Symbol.dispose]();
      }
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  };
}
