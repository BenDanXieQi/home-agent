import { atom } from "jotai";
import { isMijiaLoginAttemptActive } from "@home-agent/api/mijia";
import { householdSnapshotAtom, householdSyncedAtom } from "../household/state";
import { mijiaAccountAtom, mijiaLoginAttemptAtom } from "./account";
import { mediaBindingAtom } from "../playback/state";
import { mijiaCommandOutcomeAtom, mijiaPendingCommandAtom } from "./commands";
export const mijiaConnectionBusyAtom = atom((get) => {
  const outcome = get(mijiaCommandOutcomeAtom);
  return (
    (outcome.type === "retryConnection" && outcome.status === "pending") ||
    (get(householdSyncedAtom) &&
      (get(householdSnapshotAtom)?.projection.connection.connection?.status ===
        "running" ||
        get(mediaBindingAtom)?.status === "installing" ||
        get(mijiaAccountAtom)?.status === "restoring"))
  );
});
export const mijiaCanRetryConnectionAtom = atom(
  (get) =>
    !get(mijiaPendingCommandAtom) &&
    (!get(householdSyncedAtom) ||
      (!get(mijiaConnectionBusyAtom) &&
        (!get(mijiaAccountAtom) ||
          get(mijiaAccountAtom)?.status === "authenticated" ||
          !isMijiaLoginAttemptActive(get(mijiaLoginAttemptAtom))))),
);
