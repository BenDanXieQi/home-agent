import { createRef } from "react";
import { atom } from "jotai";
import { householdScopeEpochAtom } from "../../../modules/household/state";
import type { runSpatialPlanning } from "../../../modules/spatial/planning";
import type { SpatialSnapshot } from "../../../modules/spatial/api";
import type { PlanningImage } from "./ImageViewer";

export type Session = Awaited<ReturnType<typeof runSpatialPlanning>>;
export type Round = {
  id: string;
  images: PlanningImage[];
  text: string;
  startedAt: number;
  progress:
    | Parameters<NonNullable<Parameters<typeof runSpatialPlanning>[3]>>[0]
    | null;
  outcome:
    | (Pick<Session, "questions"> & {
        reply: NonNullable<Round["progress"]>["reply"] | undefined;
        change: string;
      })
    | null;
};

export const planningStateAtom = atom((get) => {
  get(householdScopeEpochAtom);
  return {
    text: atom(""),
    images: atom<PlanningImage[]>([]),
    rounds: atom<Round[]>([]),
    session: atom<Session | null>(null),
    base: atom<SpatialSnapshot | null>(null),
    busy: atom(false),
    reading: atom(false),
    error: atom(""),
    notice: atom(""),
    expanded: atom(false),
    pending: createRef<AbortController>(),
    sessionId: createRef<string>(),
  };
});

/** Whether an AI planning session or its conversation is still open. */
export const planningActiveAtom = atom((get) => {
  const state = get(planningStateAtom);
  return get(state.session) !== null || get(state.rounds).length > 0;
});
