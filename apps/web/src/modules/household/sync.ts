import { atom } from "jotai";
import { householdSnapshotAtom, householdSyncedAtom } from "./state";
import {
  mijiaCommandSyncPendingAtom,
  mijiaPendingCommandAtom,
} from "../mijia/commands";
export const householdSyncStatusAtom = atom((get) =>
  get(mijiaCommandSyncPendingAtom)
    ? "confirming"
    : get(householdSyncedAtom)
      ? "synced"
      : "connecting",
);
const syncMessages = {
  confirming: "操作已接收，正在等待状态同步…",
  connecting: "状态尚未同步，正在连接后台…",
  synced: null,
};
export const householdSyncMessageAtom = atom(
  (get) => syncMessages[get(householdSyncStatusAtom)],
);
export const householdReliableAtom = atom((get) => {
  const command = get(mijiaPendingCommandAtom);
  return (
    !!get(householdSnapshotAtom) &&
    get(householdSyncStatusAtom) === "synced" &&
    command !== "logout" &&
    command !== "selectHome"
  );
});
