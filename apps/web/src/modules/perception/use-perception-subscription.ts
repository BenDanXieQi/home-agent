import { useEffect } from "react";
import { useStore } from "jotai";
import { subscribePerception } from "./subscription";
import {
  perceptionSourceAccessAtom,
  reconcilePerceptionAccessAtom,
} from "./source-access";
import {
  householdSnapshotReceivedAtom,
  householdSyncedAtom,
  householdSnapshotAtom,
} from "../household/state";
import {
  perceptionBaselineAtom,
  perceptionConnectedAtom,
  receivePerceptionAtom,
  perceptionSnapshotAtom,
} from "./state";

/** One perception subscription for the video parent route, independent of backend capture. */
export function usePerceptionSubscription() {
  const store = useStore();
  useEffect(() => {
    const baseline = () => {
      const household = store.get(householdSnapshotAtom);
      store.set(
        perceptionBaselineAtom,
        household
          ? { scope_epoch: household.scope_epoch, sequence: household.sequence }
          : null,
      );
    };
    const unsubscribeHousehold = store.sub(
      householdSnapshotReceivedAtom,
      baseline,
    );
    const updateAccess = () => {
      store.set(reconcilePerceptionAccessAtom);
    };
    const unsubscribeAccess = store.sub(householdSnapshotAtom, updateAccess);
    const unsubscribeAccessSync = store.sub(householdSyncedAtom, updateAccess);
    updateAccess();
    baseline();
    const unsubscribePerception = subscribePerception(
      (snapshot) => {
        store.set(receivePerceptionAtom, snapshot);
        store.set(perceptionConnectedAtom, true);
      },
      () => {
        store.set(perceptionConnectedAtom, false);
      },
    );
    return () => {
      unsubscribeHousehold();
      unsubscribeAccess();
      unsubscribeAccessSync();
      unsubscribePerception();
      store.set(perceptionSnapshotAtom, undefined);
      store.set(perceptionBaselineAtom, null);
      store.set(perceptionSourceAccessAtom, {
        epoch: "",
        available: new Set<string>(),
        removed: new Map<string, number>(),
      });
    };
  }, [store]);
}
