import type { createStore } from "jotai";
import {
  deviceLogStateAtom,
  deviceLogReconnectAtom,
  receiveDeviceLogsAtom,
} from "./state";
import { consumeEventStream } from "../../api/event-stream";
import {
  deviceLogSnapshotSchema,
  type DeviceLogSnapshot,
} from "@home-agent/api/device-logs";
import { rpc } from "../../api/client";
const empty: DeviceLogSnapshot = { run: null, entries: [] };

/** Page-owned observation; closing it never stops backend capture. */
export function subscribeDeviceLogs(
  store: ReturnType<typeof createStore>,
  scope: string,
) {
  store.set(deviceLogStateAtom, (previous) =>
    previous.scope === scope
      ? { ...previous, connected: false }
      : { scope, data: empty, connected: false, loaded: false },
  );
  let restartRequested = false;
  let stopped = false;
  let controller: AbortController | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let delay = 1000;
  async function connect() {
    const current = new AbortController();
    controller = current;
    let hasSnapshot = false;
    try {
      await consumeEventStream(
        {
          request: (signal) =>
            rpc.api.mijia.logs.events.$get({}, { init: { signal } }),
          signal: current.signal,
          maxBufferSize: 8 * 1024 * 1024,
          silenceMs: 15_000,
        },
        (event) => {
          if (stopped || current.signal.aborted) return;
          if (
            event.event !== "snapshot" &&
            (event.event !== "update" || !hasSnapshot)
          )
            throw new Error("Invalid log event");
          const data = deviceLogSnapshotSchema.parse(JSON.parse(event.data));
          const reset = event.event === "snapshot";
          hasSnapshot = true;
          store.set(receiveDeviceLogsAtom, scope, data, reset);
          delay = 1000;
        },
      );
    } catch (error) {
      if (!stopped && !current.signal.aborted)
        console.warn("Log stream interrupted", error);
    } finally {
      current.abort();
    }
    controller = undefined;
    if (!stopped) {
      if (restartRequested) {
        restartRequested = false;
        connect().catch((backgroundError: unknown) => {
          console.error("subscription: connect failed", backgroundError);
        });
        return;
      }
      store.set(deviceLogStateAtom, (previous) => ({
        ...previous,
        connected: false,
      }));
      retryTimer = setTimeout(() => {
        connect().catch((backgroundError: unknown) => {
          console.error("subscription: connect failed", backgroundError);
        });
      }, delay);
      delay = Math.min(delay * 2, 30_000);
    }
  }
  const reconnect = () => {
    if (stopped) return;
    clearTimeout(retryTimer);
    if (controller) {
      restartRequested = true;
      controller.abort();
    } else
      connect().catch((backgroundError: unknown) => {
        console.error("subscription: connect failed", backgroundError);
      });
  };
  store.set(deviceLogReconnectAtom, () => reconnect);
  connect().catch((backgroundError: unknown) => {
    console.error("subscription: connect failed", backgroundError);
  });
  return () => {
    stopped = true;
    store.set(deviceLogReconnectAtom, null);
    store.set(deviceLogStateAtom, (previous) =>
      previous.scope === scope ? { ...previous, connected: false } : previous,
    );
    clearTimeout(retryTimer);
    controller?.abort();
  };
}
