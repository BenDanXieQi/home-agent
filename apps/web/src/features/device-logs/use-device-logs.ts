import { useEffect, useState } from "react";
import { createParser } from "eventsource-parser";
import {
  deviceLogSnapshotSchema,
  type DeviceLogSnapshot,
} from "@home-agent/api/device-logs";
import { rpc } from "../../lib/api";
const empty: DeviceLogSnapshot = { run: null, entries: [] };

/** The page observes a capture owned by the backend; unmounting only closes SSE. */
export function useDeviceLogs(scope: string) {
  const [state, setState] = useState({
    scope,
    data: empty,
    connected: false,
  });
  useEffect(() => {
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
            setState((previous) => ({
              scope,
              connected: true,
              data: {
                run: data.run,
                entries:
                  reset ||
                  previous.scope !== scope ||
                  previous.data.run?.id !== data.run?.id
                    ? data.entries
                    : [...previous.data.entries, ...data.entries].slice(-500),
              },
            }));
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
      if (!stopped) {
        setState((previous) => ({ ...previous, connected: false }));
        retryTimer = setTimeout(() => {
          void connect();
        }, delay);
        delay = Math.min(delay * 2, 30_000);
      }
    }
    void connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      controller?.abort();
    };
  }, [scope]);
  return state.scope === scope
    ? state
    : {
        scope,
        data: { run: null, entries: [] } satisfies DeviceLogSnapshot,
        connected: false,
      };
}
