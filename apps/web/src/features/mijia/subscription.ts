import { createParser } from "eventsource-parser";
import { createBackendClient } from "@home-agent/backend/client";
import {
  snapshotSchema,
  stateChangeSchema,
  resyncSchema,
  stateVersionSchema,
  applyChanges,
  householdStreamPolicy,
} from "@home-agent/api/household";
import { parseRetryAfter } from "@home-agent/api/http/retry-after";
import { appStore } from "../../lib/store";
import {
  householdSnapshotAtom,
  householdSyncedAtom,
  householdUpdatedAtom,
  householdReconnectAtom,
} from "./household-state";

/** One subscription per app/ tab. Commands never write public state. */
export function subscribeHousehold() {
  const rpc = createBackendClient("/");
  let stopped = false;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = 1_000;
  let lastMessage = 0;
  let retryAfter = 0;
  async function connect() {
    if (stopped) return;
    const current = new AbortController();
    controller = current;
    let timeout = setTimeout(() => current.abort(), 10_000);
    let stable: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let hasSnapshot = false;
    const active = () =>
      !stopped && controller === current && !current.signal.aborted;
    const resetDeadline = (ms: number) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => current.abort(), ms);
    };
    const parser = createParser({
      maxBufferSize: householdStreamPolicy.snapshotBytes + 1024 * 1024,
      onError: () => current.abort(),
      onEvent: (event) => {
        if (!active()) return;
        try {
          if (
            new TextEncoder().encode(event.data).byteLength >
            householdStreamPolicy.snapshotBytes
          )
            throw new Error("Oversized state");
          const data: unknown = JSON.parse(event.data);
          const previous = appStore.get(householdSnapshotAtom);
          switch (event.event) {
            case "snapshot": {
              const snapshot = snapshotSchema.parse(data);
              appStore.set(householdSnapshotAtom, snapshot);
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
                appStore.set(householdSnapshotAtom, undefined);
                throw new Error("Scope changed");
              }
              if (change.sequence <= previous.sequence) break;
              if (change.sequence !== previous.sequence + 1)
                throw new Error("Version gap");
              appStore.set(householdSnapshotAtom, {
                scope_epoch: change.scope_epoch,
                sequence: change.sequence,
                projection: applyChanges(previous.projection, change),
              });
              break;
            }
            case "heartbeat": {
              const beat = stateVersionSchema.parse(data);
              if (!hasSnapshot || beat.scope_epoch !== previous?.scope_epoch) {
                appStore.set(householdSnapshotAtom, undefined);
                throw new Error("Scope changed");
              }
              if (beat.sequence !== previous.sequence)
                throw new Error("Version gap");
              break;
            }
            case "resync_required": {
              const hint = resyncSchema.parse(data);
              retryAfter = Math.max(retryAfter, hint.retry_after_ms ?? 0);
              if (hint.reason === "scope_changed" || hint.reason === "stopping")
                appStore.set(householdSnapshotAtom, undefined);
              throw new Error("Resync");
            }
            default:
              throw new Error("Invalid event");
          }
          lastMessage = Date.now();
          appStore.set(householdUpdatedAtom, lastMessage);
          appStore.set(householdSyncedAtom, true);
          resetDeadline(householdStreamPolicy.silenceMs);
        } catch {
          current.abort();
        }
      },
    });
    try {
      const response = await rpc.api.mijia.events.$get(
        {},
        { init: { signal: current.signal, cache: "no-store" } },
      );
      if (response.status === 503) {
        retryAfter = Math.max(
          retryAfter,
          parseRetryAfter(response.headers.get("Retry-After")) ?? 30_000,
        );
      }
      if (
        !response.ok ||
        !response.headers.get("content-type")?.includes("text/event-stream") ||
        !response.body
      )
        throw new Error("Stream unavailable");
      resetDeadline(30_000);
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (active()) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!active()) break;
        parser.feed(decoder.decode(chunk.value, { stream: true }));
      }
    } catch {
      /* The shared sync status reports transport loss. */
    } finally {
      clearTimeout(timeout);
      clearTimeout(stable);
      current.abort();
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      parser.reset();
      if (controller === current) {
        appStore.set(householdSyncedAtom, false);
        if (!stopped) {
          timer = setTimeout(
            () => void connect(),
            Math.max(retryAfter, delay + Math.random() * 250),
          );
          retryAfter = 0;
          delay = Math.min(delay * 2, 30_000);
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
    appStore.set(householdSyncedAtom, false);
    void connect();
  };
  const visibility = () => {
    if (
      document.visibilityState === "visible" &&
      (!appStore.get(householdSyncedAtom) ||
        Date.now() - lastMessage > householdStreamPolicy.silenceMs)
    )
      reconnect();
  };
  document.addEventListener("visibilitychange", visibility);
  appStore.set(householdReconnectAtom, () => reconnect);
  void connect();
  return () => {
    stopped = true;
    controller?.abort();
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", visibility);
    appStore.set(householdReconnectAtom, null);
    appStore.set(householdSyncedAtom, false);
  };
}
