import { householdSnapshotAtom } from "../household/state";
import { atom } from "jotai";
import type { PlaybackSession } from "./session";

export function createPlaybackStatusAtom() {
  return atom<ReturnType<PlaybackSession["getSnapshot"]>["phase"]>(
    "connecting",
  );
}

// Only phase is shared. Each playback session owns its media resources.
const viewersAtom = atom(
  new Set<ReturnType<typeof createPlaybackStatusAtom>>(),
);
export const registerPlaybackAtom = atom(
  null,
  (
    get,
    set,
    source: ReturnType<typeof createPlaybackStatusAtom>,
    active: boolean,
  ) => {
    const next = new Set(get(viewersAtom));
    if (active) next.add(source);
    else next.delete(source);
    set(viewersAtom, next);
  },
);
export const playbackWaitingAtom = atom((get) =>
  [...get(viewersAtom)].some((source) => {
    const phase = get(source);
    return phase === "connecting" || phase === "waiting";
  }),
);
export const playbackFailedAtom = atom((get) =>
  [...get(viewersAtom)].some((source) => get(source) === "error"),
);

export const mediaStateAtom = atom(
  (get) => get(householdSnapshotAtom)?.projection.media.media,
);
export const mediaBindingAtom = atom((get) => get(mediaStateAtom)?.binding);
