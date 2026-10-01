import { atom } from "jotai";
import { snapshotSchema } from "@home-agent/api/household";
export const householdSnapshotAtom = atom<
  ReturnType<typeof snapshotSchema.parse> | undefined
>(undefined);
export const householdAtom = atom(
  (get) => get(householdSnapshotAtom)?.projection.household.household,
);
export const householdSyncedAtom = atom(false);
export const householdConnectionFailedAtom = atom(false);
export const householdUpdatedAtom = atom(0);
/** Counts complete authoritative snapshots; heartbeats do not confirm a new scope. */
export const householdSnapshotReceivedAtom = atom(0);
export const householdReconnectAtom = atom<(() => void) | null>(null);

export const reconnectHouseholdAtom = atom(null, (get) =>
  get(householdReconnectAtom)?.(),
);

export const householdScopeEpochAtom = atom(
  (get) => get(householdSnapshotAtom)?.scope_epoch,
);
