import { setTimeout as delay } from "node:timers/promises";
import { createReceiptJournal } from "./receipts";
import { z } from "zod";
import type { BackendClient } from "@home-agent/backend-client";
import { mergeAgentContextSnapshot } from "@home-agent/api/agent-context/merge";
import {
  agentContextEventSchema,
  agentContextPartsSchema,
  agentContextPolicy,
  agentContextScopeSchema,
  agentContextSnapshotSchema,
} from "@home-agent/api/agent-context";
import { consumeEventStream } from "@home-agent/api/http/event-stream";

/** The transport owns connection and household qualification; the shared reducer applies updates. */
export function createContextReceiver(options: { client: BackendClient }) {
  const receipts = createReceiptJournal();
  let heartbeatAt: string | null = null;
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
      receipts.clear();
      heartbeatAt = null;
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
              options.client.api.agent.context.stream.$get(
                {},
                {
                  init: {
                    headers: { Accept: "text/event-stream" },
                    signal: requestSignal,
                  },
                },
              ),
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
            const now = new Date().toISOString();
            if (message.event === "heartbeat") {
              heartbeatAt = now;
              return;
            }
            receivedAt = now;
            const next = message.data.scope;
            if (
              scope?.scope_epoch !== next?.scope_epoch ||
              scope?.account_id !== next?.account_id ||
              scope?.home_id !== next?.home_id
            ) {
              qualificationGeneration++;
              receipts.clear();
              parts = {};
              synchronized = false;
            }
            const previous = { scope, parts };
            parts = mergeAgentContextSnapshot(
              { scope, parts },
              message.data,
            ).parts;
            scope = next;
            synchronized =
              Object.keys(parts).length === partNames.length &&
              Object.values(parts).every((part) => part !== undefined);
            receipts.append(
              {
                message,
                context: { scope, parts },
                received_at: now,
                synchronized,
              },
              Buffer.byteLength(event.data),
              previous,
            );
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
      receipts.clear();
      scope = null;
      parts = {};
      receivedAt = null;
      heartbeatAt = null;
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
    receiptIndex(query?: Parameters<typeof receipts.index>[0]) {
      return {
        ...receipts.index(query),
        scope,
        connection: { status, synchronized, last_error: lastError },
        received_at: receivedAt,
        heartbeat_at: heartbeatAt,
      };
    },
    receipt(id: string) {
      return receipts.detail(id);
    },
    journalId() {
      return receipts.id();
    },
    currentScope() {
      return qualification()?.scope ?? null;
    },
    snapshot() {
      return {
        context_bytes: Buffer.byteLength(JSON.stringify({ scope, parts })),
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
        receipts.clear();
        scope = null;
        parts = {};
        receivedAt = null;
        heartbeatAt = null;
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
      receipts.clear();
      scope = null;
      parts = {};
      receivedAt = null;
      heartbeatAt = null;
      status = "stopped";
      controller?.abort();
      await running;
      running = undefined;
      controller = undefined;
    },
  };
}
