import { atom } from "jotai";
import { householdSnapshotAtom } from "../household/state";
import { householdReliableAtom } from "../household/sync";
import { mijiaAuthenticatedAtom } from "../mijia/account";
import { mijiaScopeConfirmedAtom } from "../mijia/commands";

/** A known household keeps local drafts during a transport interruption. */
export const memberScopeAtom = atom((get) => {
  const snapshot = get(householdSnapshotAtom);
  return snapshot?.projection.household.household.status === "running" &&
    snapshot.projection.household.household.homes.status === "selected" &&
    get(mijiaAuthenticatedAtom) &&
    get(mijiaScopeConfirmedAtom)
    ? snapshot.scope_epoch
    : undefined;
});
export const memberReadyAtom = atom(
  (get) => !!get(memberScopeAtom) && get(householdReliableAtom),
);
