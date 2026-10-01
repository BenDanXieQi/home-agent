import { PlaybackContext } from "./playback-context";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { useStore } from "jotai";
import { createPlaybackSessions } from "./sessions";
import { canStartPlaybackAtom } from "./access";
import { mediaStateAtom } from "./state";
import { householdSnapshotAtom, householdSyncedAtom } from "../household/state";
import { devicesAtom } from "../devices/state";

/** The video route owns connections; atoms still hold only UI state and eligibility. */
export function PlaybackProvider({
  children,
  analysisActive,
}: {
  children: ReactNode;
  analysisActive: boolean;
}) {
  const [sessions] = useState(createPlaybackSessions);
  const store = useStore();
  useLayoutEffect(() => {
    // Preserve the wall before outgoing viewers release their passive effects.
    sessions.setAnalysisActive(analysisActive);
  }, [sessions, analysisActive]);
  useEffect(() => {
    const reconcile = () => {
      if (
        document.visibilityState !== "visible" ||
        !store.get(canStartPlaybackAtom) ||
        !store.get(householdSyncedAtom)
      ) {
        sessions.close();
        return;
      }
      const epoch = store.get(householdSnapshotAtom)?.scope_epoch;
      const revision = store.get(mediaStateAtom)?.revision;
      const devices = store.get(devicesAtom);
      sessions.retain(
        (target) =>
          target.scope_epoch === epoch &&
          target.revision === revision &&
          devices.some(
            (device) =>
              device.id === target.deviceId &&
              device.camera &&
              device.channels.includes(target.channel),
          ),
      );
    };
    const unsubscribe = [
      householdSnapshotAtom,
      householdSyncedAtom,
      canStartPlaybackAtom,
    ].map((state) => store.sub(state, reconcile));
    document.addEventListener("visibilitychange", reconcile);
    reconcile();
    return () => {
      for (const stop of unsubscribe) stop();
      document.removeEventListener("visibilitychange", reconcile);
      sessions.close();
    };
  }, [sessions, store]);
  return <PlaybackContext value={sessions}>{children}</PlaybackContext>;
}
