import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import {
  stateChangeSchema,
  resyncSchema,
  stateVersionSchema,
} from "@home-agent/api/household";
import { householdLimits } from "./config";
import type { HouseholdRuntime } from "./runtime";

/** All writes, including heartbeats, share a bounded per-client FIFO. */
const noop = () => {};
const encoder = new TextEncoder();
function serialize(
  event: "snapshot" | "state_change" | "heartbeat" | "resync_required",
  payload: unknown,
  end = false,
) {
  const data = encoder.encode(
    `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
  );
  return { data, bytes: data.byteLength, snapshot: event === "snapshot", end };
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
        return (changeFrame ??= serialize(
          "state_change",
          stateChangeSchema.parse({ ...version, changes }),
        ));
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
    if (connections >= householdLimits.connections) {
      c.header("Retry-After", "30");
      return c.body(null, 503);
    }
    connections++;
    c.header("X-Accel-Buffering", "no");
    const response = streamSSE(c, async (stream) => {
      let closed = false;
      let sending = false;
      let queuedBytes = 0;
      let queuedChanges = 0;
      let last: ReturnType<typeof current>["version"] | undefined;
      const queue: ReturnType<typeof serialize>[] = [];
      let detach = noop;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let finish = noop;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      function close() {
        if (closed) return;
        closed = true;
        connections--;
        detach();
        clearInterval(heartbeat);
        clearTimeout(deadline);
        queue.length = 0;
        queuedBytes = 0;
        queuedChanges = 0;
        stream.abort();
        finish();
      }
      async function pump() {
        if (sending || closed) return;
        sending = true;
        try {
          while (queue.length && !closed) {
            const item = queue[0]!;
            deadline = setTimeout(close, householdLimits.writeTimeoutMs);
            await stream.write(item.data);
            clearTimeout(deadline);
            if (closed) return;
            queue.shift();
            if (!item.snapshot) {
              queuedBytes -= item.bytes;
              queuedChanges--;
            }
            if (item.end) {
              close();
              return;
            }
          }
        } catch {
          close();
        } finally {
          sending = false;
        }
      }
      function enqueue(item: ReturnType<typeof serialize>) {
        if (closed) return;
        const { bytes, snapshot } = item;
        if (
          bytes > householdLimits.snapshotBytes ||
          (!snapshot &&
            (queuedChanges + 1 > householdLimits.queuedChanges ||
              queuedBytes + bytes > householdLimits.changesBytes))
        ) {
          close();
          return;
        }
        if (!snapshot) {
          queuedBytes += bytes;
          queuedChanges++;
        }
        queue.push(item);
        void pump();
      }
      try {
        stream.onAbort(close);
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
        if (closed) return;
        heartbeat = setInterval(
          () => enqueue(current().heartbeat()),
          householdLimits.heartbeatMs,
        );
        await done;
      } finally {
        close();
      }
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  };
}
