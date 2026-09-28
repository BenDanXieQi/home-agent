import { atom } from "jotai";
import { householdAtom } from "../household/state";
import { mijiaAuthenticatedAtom } from "../mijia/account";
import { mijiaScopeConfirmedAtom } from "../mijia/commands";
import { mediaBindingAtom } from "./state";
export const canStartPlaybackAtom = atom(
  (get) =>
    get(mijiaAuthenticatedAtom) &&
    get(mediaBindingAtom)?.status === "ready" &&
    get(householdAtom)?.homes.status === "selected" &&
    get(householdAtom)?.status === "running" &&
    get(mijiaScopeConfirmedAtom),
);
