import { createParser } from "eventsource-parser";
import {
  roomAnalysisStateSchema,
  type roomAnalysisQuerySchema,
} from "@home-agent/api/room-analysis";
import { rpc } from "../../api/client";

export function subscribeRoomAnalysis(
  input: ReturnType<typeof roomAnalysisQuerySchema.parse>,
  receive: (state: ReturnType<typeof roomAnalysisStateSchema.parse>) => void,
  disconnected: () => void,
) {
  let stopped = false;
  let controller: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 1000;
  async function connect() {
    if (stopped) return;
    const current = new AbortController();
    controller = current;
    let deadline = setTimeout(() => current.abort(), 10_000);
    let stable: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const parser = createParser({
      maxBufferSize: 128 * 1024,
      onError: () => current.abort(),
      onEvent: (event) => {
        if (stopped || current.signal.aborted) return;
        try {
          if (new TextEncoder().encode(event.data).byteLength > 96 * 1024)
            throw new Error("Oversized analysis state");
          if (event.event === "state") {
            const value = roomAnalysisStateSchema.parse(JSON.parse(event.data));
            if (
              value.scope_epoch !== input.scope_epoch ||
              value.room_id !== input.room_id
            )
              throw new Error("Scope changed");
            receive(value);
            stable ??= setTimeout(() => {
              delay = 1000;
            }, 60_000);
          } else if (event.event !== "heartbeat")
            throw new Error("Resync analysis");
          clearTimeout(deadline);
          deadline = setTimeout(() => current.abort(), 45_000);
        } catch {
          current.abort();
        }
      },
    });
    try {
      const response = await rpc.api.rooms.analysis.events.$post(
        { json: input },
        { init: { signal: current.signal, cache: "no-store" } },
      );
      if (response.status === 503) delay = 30_000;
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get("content-type")?.includes("text/event-stream")
      )
        throw new Error("Analysis stream unavailable");
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (!current.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        parser.feed(decoder.decode(chunk.value, { stream: true }));
      }
    } catch {
      /* The viewer retains the previous summary with a disconnected label. */
    } finally {
      current.abort();
      clearTimeout(deadline);
      clearTimeout(stable);
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      if (!stopped) {
        disconnected();
        retry = setTimeout(() => {
          connect().catch(() => {
            console.warn("Room analysis reconnect failed");
          });
        }, delay);
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }
  connect().catch(() => {
    console.warn("Room analysis subscription failed");
  });
  return () => {
    stopped = true;
    controller?.abort();
    clearTimeout(retry);
  };
}
