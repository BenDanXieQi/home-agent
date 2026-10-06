import {
  mijiaTimeouts,
  mijiaPlaybackResponseSchema,
  mijiaPlaybackReservationResponseSchema,
} from "@home-agent/api/mijia";
import {
  requestJson,
  requestEmpty,
  retryOnceOnTransportFailure,
} from "../../api/client";
import type { InferRequestType } from "hono/client";
type MijiaApi =
  import("@home-agent/backend-client").BackendClient["api"]["mijia"];
export function reserveMijiaPlayback(
  target: InferRequestType<
    MijiaApi["playback"]["reservations"]["$post"]
  >["json"],
) {
  return requestJson(
    (client, options) =>
      client.api.mijia.playback.reservations.$post(
        {
          json: target,
        },
        options,
      ),
    mijiaPlaybackReservationResponseSchema,
    { timeoutMs: mijiaTimeouts.control },
  );
}

export function offerMijiaPlayback(
  id: string,
  offer: InferRequestType<MijiaApi["playback"][":id"]["$put"]>["json"],
  signal: AbortSignal,
) {
  const json = { ...offer };
  return requestJson(
    (client, options) =>
      client.api.mijia.playback[":id"].$put({ param: { id }, json }, options),
    mijiaPlaybackResponseSchema,
    {
      signal,
      timeoutMs: mijiaTimeouts.playback,
      retry: retryOnceOnTransportFailure,
    },
  );
}

export function releaseMijiaPlayback(id: string) {
  // Only the viewer is released. keepalive allows teardown during navigation.
  requestEmpty(
    (client, options) =>
      client.api.mijia.playback[":id"].$delete({ param: { id } }, options),
    { keepalive: true, timeoutMs: mijiaTimeouts.upstream },
  ).catch(() => undefined);
}
