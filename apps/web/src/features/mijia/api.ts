import {
  mijiaStateSchema,
  type MijiaState,
  mijiaTimeouts,
  mijiaPlaybackResponseSchema,
  mijiaPlaybackReservationResponseSchema,
} from "@home-agent/api/mijia";
import {
  requestJson,
  requestJsonResponse,
  requestEmpty,
  RequestError,
  retryOnceOnTransportFailure,
  type RpcJsonRequest,
  type RequestOptions,
} from "../../lib/api";
import type { InferRequestType } from "hono/client";

type MijiaApi =
  import("@home-agent/backend/client").BackendClient["api"]["mijia"];

export type MijiaCommand =
  | { type: "startLogin" }
  | { type: "cancelLogin"; loginId: string }
  | { type: "verifyLogin"; loginId: string; ticket: string }
  | { type: "retryConnection" }
  | { type: "logout" }
  | { type: "refreshDevices" };

async function requestSnapshot(
  send: RpcJsonRequest<MijiaState>,
  options: RequestOptions = {},
) {
  const response = await requestJsonResponse(send, mijiaStateSchema, {
    timeoutMs: mijiaTimeouts.control,
    ...options,
  });
  if (response.retryAfterMs === undefined)
    throw new RequestError({ code: "invalid_response" });
  return { ...response.data, pollAfterMs: response.retryAfterMs };
}

export function getMijiaState(signal?: AbortSignal) {
  return requestSnapshot(
    (client, options) => client.api.mijia.state.$get({}, options),
    {
      signal,
    },
  );
}

export function executeMijiaCommand(
  command: MijiaCommand,
  signal: AbortSignal,
) {
  switch (command.type) {
    case "startLogin":
      return requestSnapshot(
        (client, options) => client.api.mijia.login.$post({}, options),
        {
          signal,
        },
      );
    case "cancelLogin":
      return requestSnapshot(
        (client, options) =>
          client.api.mijia.login[":id"].$delete(
            { param: { id: command.loginId } },
            options,
          ),
        { signal },
      );
    case "verifyLogin":
      return requestSnapshot(
        (client, options) =>
          client.api.mijia.login[":id"].verify.$post(
            {
              param: { id: command.loginId },
              json: { ticket: command.ticket },
            },
            options,
          ),
        { signal, timeoutMs: mijiaTimeouts.verification },
      );
    case "retryConnection":
      return requestSnapshot(
        (client, options) =>
          client.api.mijia.connection.retry.$post({}, options),
        { signal },
      );
    case "logout":
      return requestSnapshot(
        (client, options) => client.api.mijia.session.$delete({}, options),
        {
          signal,
        },
      );
    case "refreshDevices":
      return requestSnapshot(
        (client, options) =>
          client.api.mijia.devices.refresh.$post({}, options),
        { signal, timeoutMs: mijiaTimeouts.devices },
      );
  }
  throw new Error("Unknown Xiaomi command");
}

export function reserveMijiaPlayback(
  target: InferRequestType<
    MijiaApi["playback"]["reservations"]["$post"]
  >["json"],
) {
  return requestJson(
    (client, options) =>
      client.api.mijia.playback.reservations.$post({ json: target }, options),
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
  void requestEmpty(
    (client, options) =>
      client.api.mijia.playback[":id"].$delete({ param: { id } }, options),
    { keepalive: true, timeoutMs: mijiaTimeouts.upstream },
  ).catch(() => undefined);
}
