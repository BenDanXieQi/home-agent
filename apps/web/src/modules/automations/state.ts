import { atom } from "jotai";
import { householdSnapshotAtom } from "../household/state";
import { householdReliableAtom } from "../household/sync";
import { mijiaAuthenticatedAtom } from "../mijia/account";
import { mijiaScopeConfirmedAtom } from "../mijia/commands";

export const automationScopeAtom = atom((get) => {
  const snapshot = get(householdSnapshotAtom);
  return snapshot?.projection.household.household.status === "running" &&
    snapshot.projection.household.household.homes.status === "selected" &&
    get(mijiaAuthenticatedAtom) &&
    get(mijiaScopeConfirmedAtom)
    ? snapshot.scope_epoch
    : undefined;
});

export const automationReadyAtom = atom(
  (get) => !!get(automationScopeAtom) && get(householdReliableAtom),
);
