import { atom } from "jotai";
import { householdScopeEpochAtom } from "../household/state";

const mediaAspectsAtom = atom<{
  scope_epoch: ReturnType<typeof householdScopeEpochAtom.read>;
  ratios: Map<string, number>;
}>({ scope_epoch: undefined, ratios: new Map() });

/** Keep the measured picture ratio available while a route takes over its media. */
export function createCameraAspectAtom(deviceId: string, channel: number) {
  const key = `${deviceId}:${channel}`;
  return atom(
    (get) => {
      const state = get(mediaAspectsAtom);
      return state.scope_epoch === get(householdScopeEpochAtom)
        ? (state.ratios.get(key) ?? 16 / 9)
        : 16 / 9;
    },
    (get, set, ratio: number) => {
      if (!Number.isFinite(ratio) || ratio <= 0) return;
      const scope_epoch = get(householdScopeEpochAtom);
      if (!scope_epoch) return;
      const state = get(mediaAspectsAtom);
      if (state.scope_epoch === scope_epoch && state.ratios.get(key) === ratio)
        return;
      const ratios = new Map(
        state.scope_epoch === scope_epoch ? state.ratios : undefined,
      );
      ratios.set(key, ratio);
      set(mediaAspectsAtom, { scope_epoch, ratios });
    },
  );
}
