import { atom } from "jotai";

import { isMijiaLoginAttemptActive } from "@home-agent/api/mijia";
import { RequestError, requestErrorMessage } from "../../lib/api";
import { executeMijiaCommand, type MijiaCommand } from "./api";
import {
  householdSnapshotAtom,
  householdSyncedAtom,
  householdUpdatedAtom,
  householdReconnectAtom,
  householdSnapshotReceivedAtom,
} from "./household-state";

export const deviceSearchAtom = atom("");
export const deviceFilterAtom = atom("all");
const emptyDeviceFilters = { room: "", category: "", capability: "" };
const scopedDeviceFiltersAtom = atom({
  scope_epoch: "",
  ...emptyDeviceFilters,
});
export const deviceFiltersAtom = atom(
  (get) => {
    const filters = get(scopedDeviceFiltersAtom);
    return filters.scope_epoch === get(householdSnapshotAtom)?.scope_epoch
      ? filters
      : emptyDeviceFilters;
  },
  (get, set, filters: typeof emptyDeviceFilters) => {
    set(scopedDeviceFiltersAtom, {
      ...filters,
      scope_epoch: get(householdSnapshotAtom)?.scope_epoch ?? "",
    });
  },
);

type Confirmation = {
  version:
    | Awaited<ReturnType<typeof executeMijiaCommand>>["state_version"]
    | null;
  snapshotAfter: number | null;
};
function confirmed(
  snapshot: ReturnType<typeof householdSnapshotAtom.read>,
  received: number,
  confirmation: Confirmation,
) {
  return (
    !!snapshot &&
    ((confirmation.version !== null &&
      snapshot.scope_epoch === confirmation.version.scope_epoch &&
      snapshot.sequence >= confirmation.version.sequence) ||
      (confirmation.snapshotAfter !== null &&
        received > confirmation.snapshotAfter))
  );
}
type CommandState = {
  pending: boolean;
  requestId: number;
  type: MijiaCommand["type"] | null;
  error: { message: string; recoverAfter?: number } | null;
  confirmation: Confirmation | null;
};
const commandStateAtom = atom<CommandState>({
  pending: false,
  requestId: 0,
  type: null,
  error: null,
  confirmation: null,
});
const commandControllerAtom = atom<AbortController | null>(null);
const mediaConfirmationAtom = atom<Confirmation | null>(null);
export const mijiaPendingCommandAtom = atom((get) => {
  const command = get(commandStateAtom);
  return command.pending ? command.type : null;
});
export const mijiaCommandSyncPendingAtom = atom((get) => {
  const confirmation = get(commandStateAtom).confirmation;
  return (
    confirmation !== null &&
    !confirmed(
      get(householdSnapshotAtom),
      get(householdSnapshotReceivedAtom),
      confirmation,
    )
  );
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
      items: get(devicesAtom),
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
export const mijiaFetchErrorAtom = atom((get) => {
  if (get(mijiaCommandSyncPendingAtom)) return "操作已接收，正在等待状态同步…";
  return get(householdSyncedAtom) ? null : "状态尚未同步，正在连接后台…";
});
export const mijiaCanStartPlaybackAtom = atom((get) => {
  const command = get(mijiaPendingCommandAtom);
  const confirmation = get(mediaConfirmationAtom);
  return (
    get(mijiaAuthenticatedAtom) &&
    get(mijiaBindingAtom)?.status === "ready" &&
    get(mijiaStateAtom)?.homes.status === "selected" &&
    get(householdSnapshotAtom)?.projection.household.household.status ===
      "running" &&
    (confirmation === null ||
      confirmed(
        get(householdSnapshotAtom),
        get(householdSnapshotReceivedAtom),
        confirmation,
      )) &&
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
const deviceRecordsAtom = atom(
  (get) => get(householdSnapshotAtom)?.projection.device,
);
export const devicesAtom = atom((get) => {
  const records = get(deviceRecordsAtom);
  return records ? Object.values(records) : emptyDevices;
});
const byName = ([, left]: [string, string], [, right]: [string, string]) =>
  left.localeCompare(right, "zh-CN");
export const deviceFilterOptionsAtom = atom((get) => {
  const rooms = new Map<string, string>();
  const categories = new Map<string, string>();
  const capabilities = new Set<string>();
  for (const device of get(devicesAtom)) {
    rooms.set(
      JSON.stringify([device.home_id, device.room_id]),
      device.room_name ?? "未分配房间",
    );
    categories.set(
      JSON.stringify(device.category),
      device.category ?? "未分类",
    );
    for (const capability of device.capability_tags)
      capabilities.add(capability);
  }
  return {
    rooms: [...rooms].toSorted(byName),
    categories: [...categories].toSorted(byName),
    capabilities,
  };
});
export const filteredDevicesAtom = atom((get) => {
  const devices = get(devicesAtom);
  const filter = get(deviceFilterAtom);
  const search = get(deviceSearchAtom).trim().toLocaleLowerCase();
  const { room, category, capability } = get(deviceFiltersAtom);
  return devices.filter(
    (device) =>
      (filter === "all" ||
        (filter === "camera"
          ? device.camera
          : device.availability === filter)) &&
      (!room || JSON.stringify([device.home_id, device.room_id]) === room) &&
      (!category || JSON.stringify(device.category) === category) &&
      (!capability ||
        device.capability_tags.some((tag) => tag === capability)) &&
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
    const requestId = previous.requestId + 1;
    get(commandControllerAtom)?.abort();
    const controller = new AbortController();
    set(commandControllerAtom, controller);
    set(commandStateAtom, {
      pending: true,
      requestId,
      type: command.type,
      error: null,
      confirmation: null,
    });
    const current = () => get(commandStateAtom).requestId === requestId;
    const changesScope = command.type === "logout";
    if (changesScope)
      set(mediaConfirmationAtom, { version: null, snapshotAfter: null });
    const confirmationFor = (version: Confirmation["version"]) => {
      const confirmation: Confirmation = { version, snapshotAfter: null };
      const received = get(householdSnapshotReceivedAtom);
      if (confirmed(get(householdSnapshotAtom), received, confirmation)) {
        confirmation.snapshotAfter = received;
      } else {
        const reconnect = get(householdReconnectAtom);
        if (reconnect) {
          // This connection starts after the HTTP outcome. Its full snapshot
          // may already supersede the returned version with another scope.
          confirmation.snapshotAfter = received;
          reconnect();
        }
      }
      return confirmation;
    };
    let error: CommandState["error"] = null;
    let confirmation: Confirmation | null = null;
    try {
      const result = await executeMijiaCommand(
        command,
        snapshot?.scope_epoch,
        controller.signal,
      );
      if (!current()) return;
      confirmation = confirmationFor(result.state_version);
      if (changesScope) set(mediaConfirmationAtom, confirmation);
    } catch (cause) {
      if (!current()) return;
      if (changesScope) set(mediaConfirmationAtom, confirmationFor(null));
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
          confirmation,
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
    state.binding.status !== "error" &&
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
    !get(mijiaPendingCommandAtom) &&
    (!get(householdSyncedAtom) ||
      (!get(mijiaConnectionBusyAtom) &&
        (!state ||
          state.account.status === "authenticated" ||
          !isMijiaLoginAttemptActive(state.loginAttempt))))
  );
});
