import { consumeEventStream } from "../../api/event-stream";
import { rpc } from "../../api/client";
import {
  snapshotSchema,
  stateChangeSchema,
  resyncSchema,
  stateVersionSchema,
  applyChanges,
  householdStreamPolicy,
} from "@home-agent/api/household";
import { parseRetryAfter } from "@home-agent/api/http/retry-after";
import type { createStore } from "jotai";
import {
  householdSnapshotAtom,
  householdSyncedAtom,
  householdConnectionFailedAtom,
  householdUpdatedAtom,
  householdReconnectAtom,
  householdSnapshotReceivedAtom,
} from "./state";

/** One subscription per app/ tab. Commands never write public state. */
export function subscribeHousehold(store: ReturnType<typeof createStore>) {
  let stopped = false;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = 1_000;
  let lastMessage = 0;
  let nextAllowedAt = 0;
  function scheduleReconnect() {
    nextAllowedAt = Math.max(
      nextAllowedAt,
      Date.now() + delay + Math.random() * 250,
    );
    delay = Math.min(delay * 2, 30_000);
    connect().catch((backgroundError: unknown) => {
      console.error("subscription: connect failed", backgroundError);
    });
  }
  async function connect() {
    if (stopped) return;
    clearTimeout(timer);
    const wait = nextAllowedAt - Date.now();
    if (wait > 0) {
      // Longer server deadlines need multiple waits within the browser timer limit.
      timer = setTimeout(
        () => {
          connect().catch((backgroundError: unknown) => {
            console.error("subscription: connect failed", backgroundError);
          });
        },
        Math.min(wait, 2_147_483_647),
      );
      return;
    }
    const current = new AbortController();
    controller = current;
    let stable: ReturnType<typeof setTimeout> | undefined;
    let hasSnapshot = false;
    const active = () =>
      !stopped && controller === current && !current.signal.aborted;
    try {
      await consumeEventStream(
        {
          request: (signal) =>
            rpc.api.mijia.events.$get(
              {},
              { init: { signal, cache: "no-store" } },
            ),
          signal: current.signal,
          maxBufferSize: householdStreamPolicy.snapshotBytes + 1024 * 1024,
          maxEventBytes: householdStreamPolicy.snapshotBytes,
          firstEventTimeoutMs: 30_000,
          silenceMs: householdStreamPolicy.silenceMs,
          onResponse(response) {
            if (response.status === 503)
              nextAllowedAt = Math.max(
                nextAllowedAt,
                Date.now() +
                  (parseRetryAfter(response.headers.get("Retry-After")) ??
                    30_000),
              );
          },
        },
        (event) => {
          if (!active()) return;
          const data: unknown = JSON.parse(event.data);
          const previous = store.get(householdSnapshotAtom);
          switch (event.event) {
            case "snapshot": {
              const snapshot = snapshotSchema.parse(data);
              store.set(householdSnapshotAtom, snapshot);
              store.set(householdSnapshotReceivedAtom, (count) => count + 1);
              hasSnapshot = true;
              clearTimeout(stable);
              stable = setTimeout(() => {
                if (active()) delay = 1_000;
              }, 60_000);
              break;
            }
            case "state_change": {
              const change = stateChangeSchema.parse(data);
              if (
                !hasSnapshot ||
                !previous ||
                change.scope_epoch !== previous.scope_epoch
              ) {
                store.set(householdSnapshotAtom, undefined);
                throw new Error("Scope changed");
              }
              if (change.sequence <= previous.sequence) break;
              if (change.sequence !== previous.sequence + 1)
                throw new Error("Version gap");
              store.set(householdSnapshotAtom, {
                scope_epoch: change.scope_epoch,
                sequence: change.sequence,
                projection: applyChanges(previous.projection, change),
              });
              break;
            }
            case "heartbeat": {
              const beat = stateVersionSchema.parse(data);
              if (!hasSnapshot || beat.scope_epoch !== previous?.scope_epoch) {
                store.set(householdSnapshotAtom, undefined);
                throw new Error("Scope changed");
              }
              if (beat.sequence !== previous.sequence)
                throw new Error("Version gap");
              break;
            }
            case "resync_required": {
              const hint = resyncSchema.parse(data);
              nextAllowedAt = Math.max(
                nextAllowedAt,
                Date.now() + (hint.retry_after_ms ?? 0),
              );
              if (hint.reason === "scope_changed" || hint.reason === "stopping")
                store.set(householdSnapshotAtom, undefined);
              throw new Error("Resync");
            }
            default:
              throw new Error("Invalid event");
          }
          lastMessage = Date.now();
          store.set(householdUpdatedAtom, lastMessage);
          store.set(householdSyncedAtom, true);
          store.set(householdConnectionFailedAtom, false);
        },
      );
    } catch (error) {
      if (active()) console.warn("Household stream interrupted", error);
    } finally {
      clearTimeout(stable);
      current.abort();
      if (controller === current) {
        controller = undefined;
        store.set(householdSyncedAtom, false);
        if (!stopped) {
          store.set(householdConnectionFailedAtom, true);
          scheduleReconnect();
        }
      }
    }
  }
  const reconnect = () => {
    if (stopped) return;
    clearTimeout(timer);
    const previous = controller;
    controller = undefined;
    previous?.abort();
    store.set(householdSyncedAtom, false);
    if (previous) scheduleReconnect();
    else
      connect().catch((backgroundError: unknown) => {
        console.error("subscription: connect failed", backgroundError);
      });
  };
  const visibility = () => {
    if (
      document.visibilityState === "visible" &&
      (!store.get(householdSyncedAtom) ||
        Date.now() - lastMessage > householdStreamPolicy.silenceMs)
    )
      reconnect();
  };
  document.addEventListener("visibilitychange", visibility);
  store.set(householdReconnectAtom, () => reconnect);
  connect().catch((backgroundError: unknown) => {
    console.error("subscription: connect failed", backgroundError);
  });
  return () => {
    stopped = true;
    controller?.abort();
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", visibility);
    store.set(householdReconnectAtom, null);
    store.set(householdSyncedAtom, false);
  };
}
