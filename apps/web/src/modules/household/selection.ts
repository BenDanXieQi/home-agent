import { queryOptions } from "@tanstack/react-query";
import { atom } from "jotai";
import { atomWithQuery } from "jotai-tanstack-query";
import { householdSnapshotAtom } from "./state";
import { mijiaAccountAtom } from "../mijia/account";
import { getSetupHomes } from "../mijia/api";

export const editingHomeScopeAtom = atom<string | null>(null);
export const homeChoicesEnabledAtom = atom((get) => {
  const snapshot = get(householdSnapshotAtom);
  const household = snapshot?.projection.household.household;
  return (
    (household?.home_id === null &&
      get(mijiaAccountAtom)?.status === "authenticated") ||
    (get(editingHomeScopeAtom) !== null &&
      get(editingHomeScopeAtom) === snapshot?.scope_epoch)
  );
});
export const homeChoicesQueryAtom = atomWithQuery((get) => {
  const snapshot = get(householdSnapshotAtom);
  return queryOptions({
    queryKey: [
      "household-setup",
      snapshot?.scope_epoch,
      snapshot?.projection.household.household.cloud_synced_at,
    ],
    queryFn: ({ signal }) => getSetupHomes(signal),
    enabled: get(homeChoicesEnabledAtom),
    gcTime: 0,
    retry: false,
  });
});
