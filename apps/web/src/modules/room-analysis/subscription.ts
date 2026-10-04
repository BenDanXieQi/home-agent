import {
  roomAnalysisStateSchema,
  type roomAnalysisQuerySchema,
} from "@home-agent/api/room-analysis";
import { parseRetryAfter } from "@home-agent/api/http/retry-after";
import { rpc } from "../../api/client";
import { consumeEventStream } from "../../api/event-stream";

export function subscribeRoomAnalysis(
  input: ReturnType<typeof roomAnalysisQuerySchema.parse>,
  receive: (state: ReturnType<typeof roomAnalysisStateSchema.parse>) => void,
  disconnected: () => void,
) {
  let stopped = false;
  let controller: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 1000;
  let nextAllowedAt = 0;
  async function connect() {
    if (stopped) return;
    const wait = nextAllowedAt - Date.now();
    if (wait > 0) {
      retry = setTimeout(
        () => {
          connect().catch((error: unknown) =>
            console.warn("Room analysis reconnect failed", error),
          );
        },
        Math.min(wait, 2_147_483_647),
      );
      return;
    }
    const current = new AbortController();
    controller = current;
    let stable: ReturnType<typeof setTimeout> | undefined;
    try {
      await consumeEventStream(
        {
          request: (signal) =>
            rpc.api.rooms.analysis.events.$post(
              { json: input },
              { init: { signal } },
            ),
          signal: current.signal,
          maxBufferSize: 128 * 1024,
          maxEventBytes: 96 * 1024,
          firstEventTimeoutMs: 10_000,
          silenceMs: 45_000,
          onResponse(response) {
            if (response.status === 503)
              nextAllowedAt =
                Date.now() +
                (parseRetryAfter(response.headers.get("Retry-After")) ??
                  30_000);
          },
        },
        (event) => {
          if (stopped || current.signal.aborted) return;
          if (event.event === "state") {
            const state = roomAnalysisStateSchema.parse(JSON.parse(event.data));
            if (
              state.scope_epoch !== input.scope_epoch ||
              state.room_id !== input.room_id
            )
              throw new Error("Room analysis scope changed");
            receive(state);
            stable ??= setTimeout(() => {
              delay = 1000;
            }, 60_000);
          } else if (event.event !== "heartbeat")
            throw new Error("Unknown room analysis event");
        },
      );
    } catch (error) {
      if (!stopped && !current.signal.aborted)
        console.warn("Room analysis stream interrupted", error);
    } finally {
      current.abort();
      controller = undefined;
      clearTimeout(stable);
      if (!stopped) {
        disconnected();
        nextAllowedAt = Math.max(nextAllowedAt, Date.now() + delay);
        delay = Math.min(delay * 2, 30_000);
        connect().catch((error: unknown) =>
          console.warn("Room analysis reconnect failed", error),
        );
      }
    }
  }
  connect().catch((error: unknown) =>
    console.warn("Room analysis subscription failed", error),
  );
  return () => {
    stopped = true;
    controller?.abort();
    clearTimeout(retry);
  };
}
