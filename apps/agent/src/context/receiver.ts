import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  agentContextEventSchema,
  agentContextPartsSchema,
  agentContextPolicy,
  agentContextScopeSchema,
  agentContextSnapshotSchema,
} from "@home-agent/api/agent-context";
import { consumeEventStream } from "@home-agent/api/http/event-stream";

/** The transport owns connection and household qualification; parts replace whole values. */
export function createContextReceiver(options: { backendUrl: string }) {
  const base = z.url({ protocol: /^https?$/ }).parse(options.backendUrl);
  const partNames = Object.keys(agentContextPartsSchema.shape);
  let scope: z.infer<typeof agentContextScopeSchema> | null = null;
  let parts: z.infer<typeof agentContextSnapshotSchema>["parts"] = {};
  let status: "stopped" | "connecting" | "connected" | "disconnected" =
    "stopped";
  let synchronized = false;
  let receivedAt: string | null = null;
  let lastError: { reason: string; at: string } | null = null;
  let nextErrorLogAt = 0;
  let connectionGeneration = 0;
  let qualificationGeneration = 0;
  let controller: AbortController | undefined;
  let running: Promise<void> | undefined;

  function qualification() {
    return status === "connected" && synchronized && scope
      ? { scope, generation: qualificationGeneration }
      : null;
  }

  async function run(signal: AbortSignal) {
    let retryMs: number = agentContextPolicy.reconnectInitialMs;
    while (!signal.aborted) {
      const generation = ++connectionGeneration;
      qualificationGeneration++;
      scope = null;
      parts = {};
      receivedAt = null;
      synchronized = false;
      status = "connecting";
      let failureReason = "request_failed";
      try {
        await consumeEventStream(
          {
            request: (requestSignal) =>
              fetch(new URL("/api/agent/context/stream", base), {
                headers: { Accept: "text/event-stream" },
                signal: requestSignal,
              }),
            signal,
            maxBufferSize: agentContextPolicy.eventBytes,
            maxEventBytes: agentContextPolicy.maxSnapshotBytes,
            firstEventTimeoutMs: agentContextPolicy.heartbeatTimeoutMs,
            silenceMs: agentContextPolicy.heartbeatTimeoutMs,
            onResponse(response) {
              failureReason = !response.ok
                ? `http_${response.status}`
                : !response.body ||
                    !response.headers
                      .get("content-type")
                      ?.includes("text/event-stream")
                  ? "invalid_event_stream"
                  : "stream_failed";
            },
          },
          (event) => {
            if (signal.aborted || generation !== connectionGeneration) return;
            const message = agentContextEventSchema.parse({
              event: event.event,
              data: JSON.parse(event.data) as unknown,
            });
            status = "connected";
            lastError = null;
            receivedAt = new Date().toISOString();
            if (message.event === "heartbeat") return;
            const next = message.data.scope;
            if (
              scope?.scope_epoch !== next?.scope_epoch ||
              scope?.account_id !== next?.account_id ||
              scope?.home_id !== next?.home_id
            ) {
              qualificationGeneration++;
              parts = {};
              synchronized = false;
            }
            scope = next;
            parts = { ...parts, ...message.data.parts };
            synchronized =
              Object.keys(parts).length === partNames.length &&
              Object.values(parts).every((part) => part !== undefined);
            if (synchronized) retryMs = agentContextPolicy.reconnectInitialMs;
          },
        );
        failureReason = "stream_ended";
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof DOMException && error.name === "TimeoutError")
          failureReason = "timeout";
        else if (error instanceof z.ZodError) failureReason = "invalid_event";
        else if (error instanceof SyntaxError) failureReason = "invalid_json";
      }
      if (signal.aborted || generation !== connectionGeneration) return;
      status = "disconnected";
      synchronized = false;
      qualificationGeneration++;
      const now = Date.now();
      lastError = { reason: failureReason, at: new Date(now).toISOString() };
      if (now >= nextErrorLogAt) {
        console.warn("Household context subscription failed", {
          reason: failureReason,
          retry_ms: retryMs,
        });
        nextErrorLogAt = now + agentContextPolicy.reconnectMaxMs;
      }
      try {
        await delay(retryMs, undefined, { signal });
      } catch (cause) {
        if (signal.aborted) return;
        throw cause;
      }
      retryMs = Math.min(retryMs * 2, agentContextPolicy.reconnectMaxMs);
    }
  }

  return {
    qualification,
    currentScope() {
      return qualification()?.scope ?? null;
    },
    snapshot() {
      return {
        scope,
        connection: { status, synchronized, last_error: lastError },
        parts,
        received_at: receivedAt,
      };
    },
    start() {
      if (running) return;
      controller = new AbortController();
      running = run(controller.signal).catch(() => {
        synchronized = false;
        status = "disconnected";
        qualificationGeneration++;
        console.error("Household context receiver stopped unexpectedly");
      });
    },
    async stop() {
      connectionGeneration++;
      qualificationGeneration++;
      synchronized = false;
      status = "stopped";
      controller?.abort();
      await running;
      running = undefined;
      controller = undefined;
    },
  };
}
