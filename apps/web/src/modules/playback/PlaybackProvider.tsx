import { PlaybackContext } from "./playback-context";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { useStore } from "jotai";
import { createPlaybackSessions } from "./sessions";
import { canStartPlaybackAtom } from "./access";
import { mediaStateAtom } from "./state";
import { householdSnapshotAtom } from "../household/state";
import { playbackPageActiveAtom } from "./page-activity";
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
        !store.get(playbackPageActiveAtom) ||
        !store.get(canStartPlaybackAtom)
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
      canStartPlaybackAtom,
      playbackPageActiveAtom,
    ].map((state) => store.sub(state, reconcile));
    reconcile();
    return () => {
      for (const stop of unsubscribe) stop();
      sessions.close();
    };
  }, [sessions, store]);
  return <PlaybackContext value={sessions}>{children}</PlaybackContext>;
}
