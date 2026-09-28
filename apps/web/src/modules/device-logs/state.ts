import { atom } from "jotai";
import { replaceEqualDeep } from "@tanstack/query-core";
import { type DeviceLogSnapshot } from "@home-agent/api/device-logs";
import { RequestError } from "../../api/errors";
import { executeCaptureCommand } from "./api";
import { householdAtom } from "../household/state";
import { commandFeedback } from "../../utils/command-feedback";

const empty: DeviceLogSnapshot = { run: null, entries: [] };
export const deviceLogScopeAtom = atom((get) => {
  const household = get(householdAtom);
  return JSON.stringify([household?.account_id, household?.home_id]);
});
export const deviceLogStateAtom = atom({
  scope: "",
  data: empty,
  connected: false,
  loaded: false,
});
export const deviceLogReconnectAtom = atom<(() => void) | null>(null);
const snapshotsReceivedAtom = atom(0);
type CaptureCommand = {
  action: "start" | "stop";
  scope: string;
};
const commandAtom = atom<{
  requestId: number;
  command: CaptureCommand | null;
  sending: boolean;
  error: unknown;
  baseline: DeviceLogSnapshot["run"];
  confirmation: {
    after: number;
    run: DeviceLogSnapshot["run"];
    uncertain: boolean;
  } | null;
}>({
  requestId: 0,
  command: null,
  sending: false,
  error: null,
  baseline: null,
  confirmation: null,
});

// Confirmation is consumed once. Later disconnects or empty snapshots cannot
// revive a completed command. An uncertain request needs evidence of its effect.
const reconcileCommandAtom = atom(null, (get, set) => {
  const command = get(commandAtom);
  const confirmation = command.confirmation;
  const logs = get(deviceLogStateAtom);
  if (
    !confirmation ||
    !logs.loaded ||
    !logs.connected ||
    logs.scope !== command.command?.scope
  )
    return;
  const run = logs.data.run;
  const expected = confirmation.run;
  const observedResult = confirmation.uncertain
    ? command.command.action === "start"
      ? !!run && run.id !== command.baseline?.id
      : !!run && run.id === command.baseline?.id && run.status !== "capturing"
    : expected
      ? run?.id === expected.id &&
        (run.status === expected.status || expected.status === "capturing")
      : run === null;
  if (
    observedResult ||
    (!confirmation.uncertain && get(snapshotsReceivedAtom) > confirmation.after)
  ) {
    set(commandAtom, { ...command, confirmation: null, error: null });
  }
});

export const receiveDeviceLogsAtom = atom(
  null,
  (get, set, scope: string, data: DeviceLogSnapshot, reset: boolean) => {
    if (scope !== get(deviceLogScopeAtom)) return;
    if (
      data.run &&
      JSON.stringify([data.run.account_id, data.run.home_id]) !== scope
    )
      return;
    const previous = get(deviceLogStateAtom);
    const run = replaceEqualDeep(previous.data.run, data.run);
    const entries =
      reset ||
      previous.scope !== scope ||
      previous.data.run?.id !== data.run?.id
        ? replaceEqualDeep(previous.data.entries, data.entries)
        : data.entries.length
          ? [...previous.data.entries, ...data.entries].slice(-500)
          : previous.data.entries;
    if (
      previous.scope !== scope ||
      !previous.connected ||
      !previous.loaded ||
      previous.data.run !== run ||
      previous.data.entries !== entries
    ) {
      set(deviceLogStateAtom, {
        scope,
        connected: true,
        loaded: true,
        data: { run, entries },
      });
    }
    if (reset) set(snapshotsReceivedAtom, (count) => count + 1);
    set(reconcileCommandAtom);
  },
);

export const deviceLogCaptureAtom = atom((get) => {
  const command = get(commandAtom);
  const active = command.command?.scope === get(deviceLogScopeAtom);
  return {
    ...commandFeedback({
      sending: active && command.sending,
      confirming:
        active &&
        command.confirmation !== null &&
        !command.confirmation.uncertain,
      failed: active && command.error !== null,
      issued: active && command.command !== null,
    }),
    action: active ? command.command?.action : null,
    error: active ? command.error : null,
  };
});

export const captureLogsAtom = atom(
  null,
  async (get, set, command: CaptureCommand) => {
    if (
      get(commandAtom).sending ||
      get(deviceLogCaptureAtom).pending ||
      command.scope !== get(deviceLogScopeAtom)
    )
      return false;
    const logs = get(deviceLogStateAtom);
    if (!logs.loaded || !logs.connected || logs.scope !== command.scope)
      return false;
    const requestId = get(commandAtom).requestId + 1;
    set(commandAtom, {
      requestId,
      command,
      sending: true,
      error: null,
      baseline: logs.data.run,
      confirmation: null,
    });
    try {
      const result = await executeCaptureCommand(command.action);
      if (get(commandAtom).requestId !== requestId) return false;
      set(commandAtom, {
        ...get(commandAtom),
        sending: false,
        confirmation: {
          after: get(snapshotsReceivedAtom),
          run: result.run,
          uncertain: false,
        },
      });
    } catch (error) {
      if (get(commandAtom).requestId !== requestId) return false;
      const uncertain =
        error instanceof RequestError &&
        ["network_error", "request_timeout"].includes(error.details.code);
      set(commandAtom, {
        ...get(commandAtom),
        sending: false,
        error,
        confirmation: uncertain
          ? { after: get(snapshotsReceivedAtom), run: null, uncertain: true }
          : null,
      });
    }
    set(reconcileCommandAtom);
    if (
      command.scope === get(deviceLogScopeAtom) &&
      get(commandAtom).confirmation
    )
      get(deviceLogReconnectAtom)?.();
    return get(commandAtom).error === null;
  },
);
