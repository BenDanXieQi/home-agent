import {
  deviceHistoryStreamEventSchema,
  deviceHistoryStreamPolicy,
  deviceHistoryStreamRequestSchema,
} from "@home-agent/api/device-history";
import { apiErrorSchema } from "@home-agent/api/contracts";
import { rpc } from "../../api/client";
import { consumeEventStream } from "@home-agent/api/http/event-stream";
import { RequestError } from "../../api/errors";
import type { HistoryQuery } from "./page";

export const historyStreamSilenceMs = deviceHistoryStreamPolicy.heartbeatMs * 3;

/** One history request; the live owner alone decides whether to reconnect. */
export async function streamDeviceHistory(
  input: HistoryQuery,
  delivery: ReturnType<
    typeof deviceHistoryStreamRequestSchema.parse
  >["delivery"],
  signal: AbortSignal,
  receive: (
    event: ReturnType<typeof deviceHistoryStreamEventSchema.parse>,
  ) => void,
  onResponse?: (response: Response) => void,
) {
  const completion = new AbortController();
  let hasPage = false;
  let complete = false;
  try {
    await consumeEventStream(
      {
        request: async (requestSignal) => {
          const response = await rpc.api["device-history"].events.$post(
            { json: { ...input, delivery } },
            { init: { signal: requestSignal, cache: "no-store" } },
          );
          onResponse?.(response);
          if (!response.ok) {
            const payload: unknown = await response
              .json()
              .catch((error: unknown) => {
                if (error instanceof SyntaxError) return null;
                throw error;
              });
            const details = apiErrorSchema.safeParse(payload);
            throw new RequestError(
              details.success ? details.data : { code: "invalid_response" },
              response.status,
            );
          }
          return response;
        },
        signal: AbortSignal.any([signal, completion.signal]),
        maxBufferSize: deviceHistoryStreamPolicy.eventBytes,
        maxEventBytes: deviceHistoryStreamPolicy.eventBytes,
        firstEventTimeoutMs: 30_000,
        silenceMs: historyStreamSilenceMs,
      },
      (message) => {
        const payload: unknown = JSON.parse(message.data);
        const parsed = deviceHistoryStreamEventSchema.safeParse({
          event: message.event,
          data: payload,
        });
        if (!parsed.success)
          throw new RequestError({ code: "invalid_response" });
        const event = parsed.data;
        switch (event.event) {
          case "page":
            if (
              (hasPage && delivery !== "export") ||
              event.data.records.length > input.limit ||
              event.data.account_id !== input.account_id ||
              event.data.home_id !== input.home_id ||
              event.data.start !== input.start ||
              (delivery !== "live" && event.data.end !== input.end)
            )
              throw new RequestError({ code: "invalid_response" });
            hasPage = true;
            break;
          case "change":
            if (
              delivery !== "live" ||
              !hasPage ||
              event.data.record_ids.length > input.limit
            )
              throw new RequestError({ code: "invalid_response" });
            break;
          case "complete":
            if (delivery === "live" || !hasPage)
              throw new RequestError({ code: "invalid_response" });
            complete = true;
            completion.abort();
            break;
          case "error":
            throw new RequestError(event.data);
        }
        receive(event);
      },
    );
  } catch (error) {
    if (!complete || signal.aborted) throw error;
  }
  signal.throwIfAborted();
  if (!complete) throw new RequestError({ code: "network_error" });
}
