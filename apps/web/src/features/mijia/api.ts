import {
  mijiaTimeouts,
  mijiaPlaybackResponseSchema,
  mijiaPlaybackReservationResponseSchema,
} from "@home-agent/api/mijia";
import {
  commandResultSchema,
  setupHomesSchema,
  loginMaterialSchema,
  type DirectoryRefreshTarget,
} from "@home-agent/api/household";
import {
  requestJson,
  requestEmpty,
  retryOnceOnTransportFailure,
} from "../../lib/api";
import { appStore } from "../../lib/store";
import { householdSnapshotAtom } from "./household-state";
import type { InferRequestType } from "hono/client";
type MijiaApi =
  import("@home-agent/backend/client").BackendClient["api"]["mijia"];
export type MijiaCommand =
  | { type: "selectHome"; homeId: string }
  | { type: "startLogin" }
  | { type: "cancelLogin"; loginId: string }
  | { type: "verifyLogin"; loginId: string; ticket: string }
  | { type: "retryConnection" }
  | { type: "logout" }
  | { type: "refreshDevices"; target?: DirectoryRefreshTarget };
export function getSetupHomes(signal: AbortSignal) {
  return requestJson(
    (client, options) => client.api.mijia.setup.homes.$get({}, options),
    setupHomesSchema,
    { signal },
  );
}
export function getLoginMaterial(id: string, signal: AbortSignal) {
  return requestJson(
    (client, options) =>
      client.api.mijia.login[":id"].material.$get({ param: { id } }, options),
    loginMaterialSchema,
    { signal },
  );
}
export function executeMijiaCommand(
  command: MijiaCommand,
  scope_epoch: string | undefined,
  signal: AbortSignal,
) {
  const options = {
    signal,
    timeoutMs:
      command.type === "verifyLogin"
        ? mijiaTimeouts.verification
        : mijiaTimeouts.control,
  };
  switch (command.type) {
    case "selectHome":
      if (!scope_epoch) throw new Error("尚未取得家庭标识，请先重新连接状态。");
      return requestJson(
        (client, opts) =>
          client.api.mijia.scope.homes.$put(
            { json: { scope_epoch, home_id: command.homeId } },
            opts,
          ),
        commandResultSchema,
        options,
      );
    case "startLogin":
      return requestJson(
        (client, opts) => client.api.mijia.login.$post({}, opts),
        commandResultSchema,
        options,
      );
    case "cancelLogin":
      if (!command.loginId) throw new Error("缺少要取消的登录尝试标识。");
      return requestJson(
        (client, opts) =>
          client.api.mijia.login[":id"].$delete(
            { param: { id: command.loginId } },
            opts,
          ),
        commandResultSchema,
        options,
      );
    case "verifyLogin":
      if (!command.loginId) throw new Error("缺少要验证的登录尝试标识。");
      return requestJson(
        (client, opts) =>
          client.api.mijia.login[":id"].verify.$post(
            {
              param: { id: command.loginId },
              json: { ticket: command.ticket },
            },
            opts,
          ),
        commandResultSchema,
        options,
      );
    case "retryConnection":
      return requestJson(
        (client, opts) => client.api.mijia.connection.retry.$post({}, opts),
        commandResultSchema,
        options,
      );
    case "logout":
      return requestJson(
        (client, opts) => client.api.mijia.session.$delete({}, opts),
        commandResultSchema,
        options,
      );
    case "refreshDevices":
      if (!scope_epoch) throw new Error("尚未取得家庭标识，请先重新连接状态。");
      return requestJson(
        (client, opts) =>
          client.api.mijia.devices.refresh.$post(
            { json: { scope_epoch, target: command.target ?? "directory" } },
            opts,
          ),
        commandResultSchema,
        options,
      );
  }
  throw new Error("Unknown command");
}

export function reserveMijiaPlayback(
  target: Omit<
    InferRequestType<MijiaApi["playback"]["reservations"]["$post"]>["json"],
    "scope_epoch"
  >,
) {
  return requestJson(
    (client, options) =>
      client.api.mijia.playback.reservations.$post(
        {
          json: {
            ...target,
            scope_epoch: appStore.get(householdSnapshotAtom)?.scope_epoch ?? "",
          },
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
  void requestEmpty(
    (client, options) =>
      client.api.mijia.playback[":id"].$delete({ param: { id } }, options),
    { keepalive: true, timeoutMs: mijiaTimeouts.upstream },
  ).catch(() => undefined);
}
