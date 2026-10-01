import { replaceEqualDeep } from "@tanstack/query-core";
import { atom } from "jotai";
import type { perceptionSnapshotSchema } from "@home-agent/api/contracts";
import type { stateVersionSchema } from "@home-agent/api/household";
import { householdSnapshotAtom, householdSyncedAtom } from "../household/state";

export const perceptionSnapshotAtom =
  atom<ReturnType<typeof perceptionSnapshotSchema.parse>>();
export const perceptionConnectedAtom = atom(false);
export const receivePerceptionAtom = atom(
  null,
  (get, set, snapshot: ReturnType<typeof perceptionSnapshotSchema.parse>) => {
    const previous = get(perceptionSnapshotAtom);
    // The single SSE reader delivers snapshots in order and replaces them on reconnect.
    set(perceptionSnapshotAtom, replaceEqualDeep(previous, snapshot));
  },
);
export const perceptionBaselineAtom = atom<ReturnType<
  typeof stateVersionSchema.parse
> | null>(null);
export const perceptionSyncedAtom = atom((get) => {
  const perception = get(perceptionSnapshotAtom);
  const household = get(householdSnapshotAtom);
  const baseline = get(perceptionBaselineAtom);
  return (
    (!baseline ||
      (perception?.householdVersion?.scope_epoch === baseline.scope_epoch &&
        perception.householdVersion.sequence >= baseline.sequence)) &&
    get(perceptionConnectedAtom) &&
    get(householdSyncedAtom) &&
    !!household &&
    !!perception?.householdVersion &&
    perception.householdVersion.scope_epoch === household.scope_epoch &&
    perception.householdVersion.sequence <= household.sequence
  );
});
