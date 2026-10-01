import { atom } from "jotai";
import { householdSnapshotAtom, householdSyncedAtom } from "../household/state";

/** Owned by the video route, so removals survive list/detail navigation. */
export const perceptionSourceAccessAtom = atom({
  epoch: "",
  available: new Set<string>(),
  removed: new Map<string, number>(),
});

export const reconcilePerceptionAccessAtom = atom(null, (get, set) => {
  const household = get(householdSnapshotAtom);
  if (!household || !get(householdSyncedAtom)) return;
  const previous = get(perceptionSourceAccessAtom);
  const available = new Set(
    Object.values(household.projection.device)
      .filter((device) => device.camera)
      .flatMap((device) =>
        device.channels.map((channel) => `${device.id}:${channel}`),
      ),
  );
  const sameEpoch = previous.epoch === household.scope_epoch;
  if (
    sameEpoch &&
    available.size === previous.available.size &&
    [...available].every((key) => previous.available.has(key))
  )
    return;
  const removed = sameEpoch
    ? new Map(previous.removed)
    : new Map<string, number>();
  if (sameEpoch) {
    for (const key of previous.available) {
      if (!available.has(key)) removed.set(key, household.sequence);
    }
  }
  set(perceptionSourceAccessAtom, {
    epoch: household.scope_epoch,
    available,
    removed,
  });
});
