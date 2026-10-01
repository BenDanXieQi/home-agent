import { consumeEventStream } from "../../api/event-stream";
import { perceptionSnapshotSchema } from "@home-agent/api/contracts";
import { rpc } from "../../api/client";

export function subscribePerception(
  receive: (
    snapshot: ReturnType<typeof perceptionSnapshotSchema.parse>,
  ) => void,
  disconnected: () => void,
) {
  let stopped = false;
  let controller: AbortController | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  async function connect() {
    if (stopped) return;
    const current = new AbortController();
    controller = current;
    try {
      await consumeEventStream(
        {
          request: (signal) =>
            rpc.api.perception.stream.$get({}, { init: { signal } }),
          signal: current.signal,
          maxBufferSize: 2 * 1024 * 1024,
          maxEventBytes: 2 * 1024 * 1024,
          silenceMs: 20_000,
        },
        (event) => {
          if (stopped || current.signal.aborted) return;
          if (event.event === "snapshot")
            receive(perceptionSnapshotSchema.parse(JSON.parse(event.data)));
          else if (event.event !== "heartbeat")
            throw new Error("Unknown perception event");
        },
      );
    } catch (error) {
      if (!stopped) console.warn("Perception subscription interrupted", error);
    } finally {
      current.abort();
      controller = undefined;
      if (!stopped) {
        disconnected();
        retryTimer = setTimeout(() => {
          connect().catch((error) =>
            console.error("Perception reconnect failed", error),
          );
        }, 1000);
      }
    }
  }
  connect().catch((error) =>
    console.error("Perception subscription failed", error),
  );
  return () => {
    stopped = true;
    clearTimeout(retryTimer);
    controller?.abort();
    disconnected();
  };
}
