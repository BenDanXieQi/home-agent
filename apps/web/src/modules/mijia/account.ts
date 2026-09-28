import { atom } from "jotai";
import { isMijiaLoginAttemptActive } from "@home-agent/api/mijia";
import { householdSnapshotAtom } from "../household/state";
export const mijiaAccountAtom = atom(
  (get) => get(householdSnapshotAtom)?.projection.account.account,
);
export const mijiaLoginAttemptAtom = atom(
  (get) => get(householdSnapshotAtom)?.projection.login.login,
);
export const mijiaAuthenticatedAtom = atom(
  (get) => get(mijiaAccountAtom)?.status === "authenticated",
);
export const mijiaActiveLoginIdAtom = atom((get) => {
  const attempt = get(mijiaLoginAttemptAtom);
  return isMijiaLoginAttemptActive(attempt)
    ? (attempt?.id ?? undefined)
    : undefined;
});
