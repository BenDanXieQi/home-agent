import { atom } from "jotai";
import { householdScopeEpochAtom } from "../household/state";

function createPlaybackChoices(scope_epoch: string | undefined) {
  return { scope_epoch, paused: new Set<string>() };
}

const playbackChoicesAtom = atom(createPlaybackChoices(undefined));
const unpaused = new Set<string>();

/** List and expanded viewers share choices for the current household runtime. */
export const pausedPlaybackKeysAtom = atom((get) => {
  const choices = get(playbackChoicesAtom);
  return choices.scope_epoch === get(householdScopeEpochAtom)
    ? choices.paused
    : unpaused;
});

export const setPlaybackEnabledAtom = atom(
  null,
  (get, set, key: string, enabled: boolean) => {
    const scope_epoch = get(householdScopeEpochAtom);
    if (!scope_epoch) return;
    const choices = get(playbackChoicesAtom);
    const paused = new Set(
      choices.scope_epoch === scope_epoch ? choices.paused : unpaused,
    );
    if (enabled) paused.delete(key);
    else paused.add(key);
    set(playbackChoicesAtom, { scope_epoch, paused });
  },
);
