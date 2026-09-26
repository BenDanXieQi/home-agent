import { atom } from "jotai";
import { snapshotSchema } from "@home-agent/api/household";
export const householdSnapshotAtom = atom<
  ReturnType<typeof snapshotSchema.parse> | undefined
>(undefined);
export const householdSyncedAtom = atom(false);
export const householdUpdatedAtom = atom(0);
/** Counts complete authoritative snapshots; heartbeats do not confirm a new scope. */
export const householdSnapshotReceivedAtom = atom(0);
export const householdReconnectAtom = atom<(() => void) | null>(null);
