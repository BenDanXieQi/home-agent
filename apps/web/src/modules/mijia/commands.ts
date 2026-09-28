import { atom } from "jotai";
import { commandFeedback } from "../../utils/command-feedback";
import { RequestError } from "../../api/errors";
import { requestErrorMessage } from "../../messages/zh-CN";
import { executeMijiaCommand, type MijiaCommand } from "./api";
import { mijiaAccountAtom } from "./account";
import { mediaBindingAtom } from "../playback/state";
import { deviceInventoryAtom } from "../devices/state";
import {
  isHouseholdConfirmed,
  type Confirmation,
} from "../household/confirmation";
import {
  householdSnapshotAtom,
  householdConnectionFailedAtom,
  householdUpdatedAtom,
  householdReconnectAtom,
  householdSnapshotReceivedAtom,
} from "../household/state";
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

export const mijiaCommandFeedbackAtom = atom((get) => {
  const command = get(commandStateAtom);
  return commandFeedback({
    sending: command.pending,
    // A failed connection releases controls for a manual retry. A requested
    // resync is still part of the command, even while the stream reconnects.
    confirming:
      get(mijiaCommandSyncPendingAtom) && !get(householdConnectionFailedAtom),
    failed: command.error !== null,
    issued: command.type !== null,
  });
});
export const mijiaPendingCommandAtom = atom((get) => {
  const command = get(commandStateAtom);
  return command.pending ? command.type : null;
});
/** Request and state confirmation share the same feedback in every control. */
export const mijiaCommandOutcomeAtom = atom((get) => ({
  type: get(commandStateAtom).type,
  status: get(mijiaCommandFeedbackAtom).status,
}));
export const mijiaCommandSyncPendingAtom = atom((get) => {
  const confirmation = get(commandStateAtom).confirmation;
  return (
    confirmation !== null &&
    !isHouseholdConfirmed(
      get(householdSnapshotAtom),
      get(householdSnapshotReceivedAtom),
      confirmation,
    )
  );
});
export const mijiaActionErrorAtom = atom((get) => {
  const operation = get(householdSnapshotAtom)?.projection.connection
    .connection;
  const connectionRecovered =
    get(mijiaAccountAtom)?.status === "authenticated" &&
    get(mediaBindingAtom)?.status === "ready" &&
    get(deviceInventoryAtom)?.status === "ready";
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
    get(householdUpdatedAtom) > error.recoverAfter
  )
    return operationError;
  return error.message;
});
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
    const changesScope =
      command.type === "logout" || command.type === "selectHome";
    if (changesScope)
      set(mediaConfirmationAtom, { version: null, snapshotAfter: null });
    const confirmationFor = (version: Confirmation["version"]) => {
      const confirmation: Confirmation = { version, snapshotAfter: null };
      const received = get(householdSnapshotReceivedAtom);
      if (
        isHouseholdConfirmed(get(householdSnapshotAtom), received, confirmation)
      ) {
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

export const mijiaAutomaticLoginBlockedAtom = atom((get) => {
  const command = get(commandStateAtom);
  return (
    command.pending || (command.type === "startLogin" && command.error !== null)
  );
});
export const mijiaScopeConfirmedAtom = atom((get) => {
  const confirmation = get(mediaConfirmationAtom);
  const command = get(mijiaPendingCommandAtom);
  return (
    command !== "logout" &&
    command !== "selectHome" &&
    (confirmation === null ||
      isHouseholdConfirmed(
        get(householdSnapshotAtom),
        get(householdSnapshotReceivedAtom),
        confirmation,
      ))
  );
});
