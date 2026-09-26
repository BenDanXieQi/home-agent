import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import {
  snapshotSchema,
  stateChangeSchema,
  resyncSchema,
  stateVersionSchema,
} from "@home-agent/api/household";
import { projectionChanges } from "./projection";
import { householdLimits, jsonBytes } from "./config";
import type { HouseholdRuntime } from "./runtime";

/** All writes, including heartbeats, share a bounded per-client FIFO. */
const noop = () => {};
export function createHouseholdStream(runtime: HouseholdRuntime) {
  let connections = 0;
  return (c: Context) => {
    if (connections >= householdLimits.connections) {
      c.header("Retry-After", "30");
      return c.body(null, 503);
    }
    connections++;
    c.header("Cache-Control", "no-store");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let closed = false;
      let sending = false;
      let queuedBytes = 0;
      let queuedChanges = 0;
      let last: ReturnType<HouseholdRuntime["snapshot"]> | undefined;
      const queue: {
        event: string;
        data: string;
        bytes: number;
        snapshot: boolean;
        end: boolean;
      }[] = [];
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
            await stream.writeSSE({ event: item.event, data: item.data });
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
      function enqueue(event: string, payload: unknown, end = false) {
        if (closed) return;
        const data = JSON.stringify(payload);
        const bytes = Buffer.byteLength(data) + Buffer.byteLength(event) + 16;
        const snapshot = event === "snapshot";
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
        queue.push({ event, data, bytes, snapshot, end });
        void pump();
      }
      try {
        stream.onAbort(close);
        // No await between registration and the single committed snapshot.
        detach = runtime.subscribe(() => {
          const next = runtime.snapshot();
          if (
            !last ||
            next.scope_epoch !== last.scope_epoch ||
            next.projection.household.household.status === "stopping"
          ) {
            enqueue(
              "resync_required",
              resyncSchema.parse({
                ...runtime.version(),
                reason:
                  next.projection.household.household.status === "stopping"
                    ? "stopping"
                    : "scope_changed",
              }),
              true,
            );
          } else if (next.sequence > last.sequence) {
            enqueue(
              "state_change",
              stateChangeSchema.parse({
                ...runtime.version(),
                changes: projectionChanges(last.projection, next.projection),
              }),
            );
          }
          last = next;
        });
        last = runtime.snapshot();
        if (jsonBytes(last) > householdLimits.snapshotBytes) {
          close();
          return;
        }
        enqueue("snapshot", snapshotSchema.parse(last));
        heartbeat = setInterval(
          () =>
            enqueue("heartbeat", stateVersionSchema.parse(runtime.version())),
          householdLimits.heartbeatMs,
        );
        await done;
      } finally {
        close();
      }
    });
  };
}
