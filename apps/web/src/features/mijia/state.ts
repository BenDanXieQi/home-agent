import { atom } from "jotai";
import { atomWithQuery, queryClientAtom } from "jotai-tanstack-query";
import {
  isMijiaLoginAttemptActive,
  type MijiaState,
} from "@home-agent/api/mijia";
import { RequestError, requestErrorMessage } from "../../lib/api";
import { executeMijiaCommand, type MijiaCommand } from "./api";
import { mijiaStateQueryOptions } from "./queries";

export const deviceSearchAtom = atom("");
export const deviceFilterAtom = atom("all");

type CommandState = {
  pending: boolean;
  requestId: number;
  type: MijiaCommand["type"] | null;
  error: { message: string; recoverAfter?: number } | null;
};
const commandStateAtom = atom<CommandState>({
  pending: false,
  requestId: 0,
  type: null,
  error: null,
});
const commandControllerAtom = atom<AbortController | null>(null);
const mediaConfirmationAfterAtom = atom(0);
export const mijiaPendingCommandAtom = atom((get) => {
  const command = get(commandStateAtom);
  return command.pending ? command.type : null;
});
export const mijiaActionErrorAtom = atom((get) => {
  const state = get(mijiaStateAtom);
  const operation = state?.connectionOperation;
  const connectionRecovered =
    state?.account.status === "authenticated" &&
    state.binding.status === "ready" &&
    state.devices.status === "ready";
  // Keep the operation's historical outcome without presenting it as a current fault.
  const operationError =
    operation?.status === "failed" && !connectionRecovered
      ? requestErrorMessage(new RequestError(operation.error))
      : null;
  const error = get(commandStateAtom).error;
  if (!error) return operationError;
  // A fresh snapshot resolves a transport failure, not a rejected business action.
  if (
    error.recoverAfter !== undefined &&
    get(mijiaUpdatedAtAtom) > error.recoverAfter
  )
    return operationError;
  return error.message;
});

export const mijiaQueryAtom = atomWithQuery((get) => ({
  ...mijiaStateQueryOptions,
  enabled:
    !get(commandStateAtom).pending ||
    get(commandStateAtom).type === "verifyLogin",
}));
export const mijiaStateAtom = atom((get) => get(mijiaQueryAtom).data);
export const mijiaLoginAttemptAtom = atom(
  (get) => get(mijiaStateAtom)?.loginAttempt,
);
export const mijiaConnectionPendingAtom = atom(
  (get) => get(mijiaStateAtom)?.connectionOperation?.status === "running",
);
export const mijiaAccountAtom = atom((get) => get(mijiaStateAtom)?.account);
export const mijiaBindingAtom = atom((get) => get(mijiaStateAtom)?.binding);
export const mijiaAuthenticatedAtom = atom(
  (get) => get(mijiaAccountAtom)?.status === "authenticated",
);
export const mijiaFetchingAtom = atom((get) => get(mijiaQueryAtom).isFetching);
export const mijiaUpdatedAtAtom = atom(
  (get) => get(mijiaQueryAtom).dataUpdatedAt,
);
export const mijiaFetchErrorAtom = atom((get) => {
  const error = get(mijiaQueryAtom).error;
  return error ? requestErrorMessage(error) : null;
});
export const mijiaCanStartPlaybackAtom = atom((get) => {
  const command = get(mijiaPendingCommandAtom);
  return (
    get(mijiaAuthenticatedAtom) &&
    get(mijiaBindingAtom)?.status === "ready" &&
    get(mijiaUpdatedAtAtom) > get(mediaConfirmationAfterAtom) &&
    command !== "logout"
  );
});
export const mijiaReliableAtom = atom((get) => {
  const command = get(mijiaPendingCommandAtom);
  return (
    !!get(mijiaStateAtom) && !get(mijiaFetchErrorAtom) && command !== "logout"
  );
});
export const mijiaDeviceCountAtom = atom((get) => {
  const devices = get(mijiaStateAtom)?.devices;
  return devices?.status === "ready" ? devices.items.length : null;
});
const emptyDevices: MijiaState["devices"]["items"] = [];
export const devicesAtom = atom(
  (get) => get(mijiaStateAtom)?.devices.items ?? emptyDevices,
);
export const filteredDevicesAtom = atom((get) => {
  const devices = get(devicesAtom);
  const filter = get(deviceFilterAtom);
  const search = get(deviceSearchAtom).trim().toLocaleLowerCase();
  return devices.filter(
    (device) =>
      (filter === "all" ||
        (filter === "online" ? device.online : device.camera)) &&
      `${device.name} ${device.model}`.toLocaleLowerCase().includes(search),
  );
});

// Both React and appStore.set use this command boundary. Only command metadata
// is retained; sensitive input stays in the request execution, never a cache.
export const performMijiaAtom = atom(
  null,
  async (get, set, command: MijiaCommand) => {
    const previous = get(commandStateAtom);
    const interruptsVerification =
      previous.type === "verifyLogin" &&
      (command.type === "cancelLogin" || command.type === "startLogin");
    if (previous.pending && !interruptsVerification) return;
    const client = get(queryClientAtom);
    const requestId = previous.requestId + 1;
    get(commandControllerAtom)?.abort();
    const controller = new AbortController();
    set(commandControllerAtom, controller);
    set(commandStateAtom, {
      pending: true,
      requestId,
      type: command.type,
      error: null,
    });
    const current = () => get(commandStateAtom).requestId === requestId;
    if (command.type === "logout") {
      // An uncertain ownership change needs a new snapshot before media resumes.
      set(
        mediaConfirmationAfterAtom,
        client.getQueryState(mijiaStateQueryOptions.queryKey)?.dataUpdatedAt ??
          0,
      );
    }
    let error: CommandState["error"] = null;
    try {
      await client.cancelQueries({ queryKey: mijiaStateQueryOptions.queryKey });
      if (!current()) return;
      const state = await executeMijiaCommand(command, controller.signal);
      if (!current()) return;
      // Verification polls may have captured the preceding login state.
      await client.cancelQueries({ queryKey: mijiaStateQueryOptions.queryKey });
      if (!current()) return;
      client.setQueryData(mijiaStateQueryOptions.queryKey, state);
    } catch (cause) {
      if (!current()) return;
      const transient =
        cause instanceof RequestError &&
        ["network_error", "request_timeout"].includes(cause.details.code);
      error = {
        message: requestErrorMessage(cause),
        ...(transient
          ? {
              recoverAfter:
                client.getQueryState(mijiaStateQueryOptions.queryKey)
                  ?.dataUpdatedAt ?? 0,
            }
          : {}),
      };
      await client
        .fetchQuery({ ...mijiaStateQueryOptions, staleTime: 0 })
        .catch(() => undefined);
    } finally {
      if (current()) {
        set(commandControllerAtom, null);
        set(commandStateAtom, {
          pending: false,
          requestId,
          type: command.type,
          error,
        });
      }
    }
  },
);
export const refreshMijiaAtom = atom(null, async (get) => {
  const command = get(commandStateAtom);
  if (command.pending && command.type !== "verifyLogin") return;
  await get(queryClientAtom)
    .fetchQuery({ ...mijiaStateQueryOptions, staleTime: 0 })
    .catch(() => undefined);
});

export const mijiaActiveLoginIdAtom = atom((get) => {
  const attempt = get(mijiaLoginAttemptAtom);
  return isMijiaLoginAttemptActive(attempt) ? attempt.id : undefined;
});
export const mijiaConnectionBusyAtom = atom(
  (get) =>
    get(mijiaConnectionPendingAtom) ||
    get(mijiaBindingAtom)?.status === "installing" ||
    get(mijiaAccountAtom)?.status === "restoring",
);
export const mijiaCanRetryConnectionAtom = atom((get) => {
  const state = get(mijiaStateAtom);
  return (
    !!state &&
    !get(mijiaFetchErrorAtom) &&
    !get(mijiaPendingCommandAtom) &&
    !get(mijiaConnectionBusyAtom) &&
    (state.account.status === "authenticated" ||
      !isMijiaLoginAttemptActive(state.loginAttempt))
  );
});
