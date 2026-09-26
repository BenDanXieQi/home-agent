import { atom } from "jotai";

import { isMijiaLoginAttemptActive } from "@home-agent/api/mijia";
import { RequestError, requestErrorMessage } from "../../lib/api";
import { executeMijiaCommand, type MijiaCommand } from "./api";
import {
  householdSnapshotAtom,
  householdSyncedAtom,
  householdUpdatedAtom,
  householdReconnectAtom,
} from "./household-state";
import { appStore } from "../../lib/store";

const noop = () => {};
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

export const mijiaStateAtom = atom((get) => {
  const snapshot = get(householdSnapshotAtom);
  if (!snapshot) return undefined;
  const p = snapshot.projection;
  const household = p.household.household;
  return {
    account: p.account.account,
    loginAttempt: p.login.login,
    connectionOperation: p.connection.connection,
    revision: p.media.media.revision,
    binding: p.media.media.binding,
    homes: household.homes,
    devices: {
      status:
        household.sync_status === "error"
          ? ("error" as const)
          : household.sync_status === "synced"
            ? ("ready" as const)
            : ("loading" as const),
      items: Object.values(p.device),
      error: household.error,
    },
  };
});
export const mijiaLoginAttemptAtom = atom(
  (get) => get(mijiaStateAtom)?.loginAttempt,
);
export const mijiaConnectionPendingAtom = atom(
  (get) => get(mijiaStateAtom)?.connectionOperation?.status === "running",
);
export const mijiaAccountAtom = atom((get) => get(mijiaStateAtom)?.account);
export const mijiaAccountLabelAtom = atom((get) => {
  if (get(mijiaFetchErrorAtom)) return "状态不可用";
  switch (get(mijiaAccountAtom)?.status) {
    case "authenticated":
      return "已登录";
    case "restoring":
      return "正在恢复";
    case "restore_error":
      return "恢复失败";
    case "reauth_required":
      return "需要重新登录";
    default:
      return "未登录";
  }
});
export const mijiaBindingAtom = atom((get) => get(mijiaStateAtom)?.binding);
export const mijiaAuthenticatedAtom = atom(
  (get) => get(mijiaAccountAtom)?.status === "authenticated",
);
export const mijiaFetchingAtom = atom((get) => !get(householdSyncedAtom));
export const mijiaUpdatedAtAtom = householdUpdatedAtom;
export const mijiaFetchErrorAtom = atom((get) =>
  get(householdSyncedAtom) ? null : "状态尚未同步，正在连接后台…",
);
export const mijiaCanStartPlaybackAtom = atom((get) => {
  const command = get(mijiaPendingCommandAtom);
  return (
    get(mijiaAuthenticatedAtom) &&
    get(mijiaBindingAtom)?.status === "ready" &&
    get(mijiaStateAtom)?.homes.status === "selected" &&
    get(householdSnapshotAtom)?.projection.household.household.status ===
      "running" &&
    get(mijiaUpdatedAtAtom) > get(mediaConfirmationAfterAtom) &&
    command !== "logout" &&
    command !== "selectHome"
  );
});
export const mijiaReliableAtom = atom((get) => {
  const command = get(mijiaPendingCommandAtom);
  return (
    !!get(mijiaStateAtom) &&
    !get(mijiaFetchErrorAtom) &&
    command !== "logout" &&
    command !== "selectHome"
  );
});
export const mijiaDeviceCountAtom = atom((get) => {
  const devices = get(mijiaStateAtom)?.devices;
  return devices?.status === "ready" ? devices.items.length : null;
});
const emptyDevices: NonNullable<
  ReturnType<typeof householdSnapshotAtom.read>
>["projection"]["device"][string][] = [];
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
        (filter === "online"
          ? device.availability === "online"
          : filter === "unknown"
            ? device.availability === "unknown"
            : device.camera)) &&
      `${device.name} ${device.alias ?? ""} ${device.model}`
        .toLocaleLowerCase()
        .includes(search),
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
    const snapshot = get(householdSnapshotAtom);
    if (!snapshot || !get(householdSyncedAtom)) return;
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
    if (command.type === "logout" || command.type === "selectHome") {
      // An uncertain ownership change needs a new snapshot before media resumes.
      set(mediaConfirmationAfterAtom, get(householdUpdatedAtom));
    }
    let error: CommandState["error"] = null;
    try {
      const result = await executeMijiaCommand(
        command,
        snapshot.scope_epoch,
        controller.signal,
      );
      if (!current()) return;
      await new Promise<void>((resolve, reject) => {
        let unsubscribe = noop;
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new Error("操作已接收，状态尚未同步"));
        }, 5_000);
        const check = () => {
          const state = appStore.get(householdSnapshotAtom);
          if (
            state &&
            state.scope_epoch === result.state_version.scope_epoch &&
            state.sequence >= result.state_version.sequence
          ) {
            clearTimeout(timer);
            unsubscribe();
            resolve();
          }
        };
        unsubscribe = appStore.sub(householdSnapshotAtom, check);
        check();
      });
    } catch (cause) {
      if (!current()) return;
      const transient =
        cause instanceof RequestError &&
        ["network_error", "request_timeout"].includes(cause.details.code);
      error = {
        message: requestErrorMessage(cause),
        ...(transient
          ? {
              recoverAfter: get(householdUpdatedAtom),
            }
          : {}),
      };
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

export const mijiaCanStartLoginAutomaticallyAtom = atom((get) => {
  const state = get(mijiaStateAtom);
  const command = get(commandStateAtom);
  return (
    !!state &&
    !get(mijiaFetchErrorAtom) &&
    !command.pending &&
    !(command.type === "startLogin" && command.error) &&
    (state.account.status === "idle" ||
      state.account.status === "reauth_required") &&
    !(state.account.status === "idle" && state.binding.status === "error") &&
    (state.loginAttempt.status === "idle" ||
      state.loginAttempt.status === "expired")
  );
});

export const startMijiaLoginAutomaticallyAtom = atom(null, async (get, set) => {
  // Recheck shared state at dispatch: StrictMode or another mounted consumer
  // must not replace the attempt that the first caller has already started.
  if (!get(mijiaCanStartLoginAutomaticallyAtom)) return;
  await set(performMijiaAtom, { type: "startLogin" });
});

export const refreshMijiaAtom = atom(null, (get) => {
  get(householdReconnectAtom)?.();
});

export const mijiaActiveLoginIdAtom = atom((get) => {
  const attempt = get(mijiaLoginAttemptAtom);
  return isMijiaLoginAttemptActive(attempt)
    ? (attempt?.id ?? undefined)
    : undefined;
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
