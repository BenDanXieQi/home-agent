import type { createStore } from "jotai";
import {
  deviceLogStateAtom,
  deviceLogReconnectAtom,
  receiveDeviceLogsAtom,
} from "./state";
import { createParser } from "eventsource-parser";
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
    let deadline = setTimeout(() => current.abort(), 10_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let hasSnapshot = false;
    const parser = createParser({
      maxBufferSize: 8 * 1024 * 1024,
      onError: () => current.abort(),
      onEvent: (event) => {
        if (stopped || current.signal.aborted) return;
        try {
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
          clearTimeout(deadline);
          deadline = setTimeout(() => current.abort(), 15_000);
        } catch {
          current.abort();
        }
      },
    });
    try {
      const response = await rpc.api.mijia.logs.events.$get(
        {},
        { init: { signal: current.signal } },
      );
      if (!response.ok || !response.body)
        throw new Error("Log stream unavailable");
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (!current.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        parser.feed(decoder.decode(chunk.value, { stream: true }));
      }
    } catch {
      /* The stream reconnects without stopping the capture. */
    } finally {
      clearTimeout(deadline);
      current.abort();
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
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
