import { useEffect } from "react";
import { useStore } from "jotai";
import { subscribePerception } from "./subscription";
import type { createPerceptionSourceState } from "./source-state";

/** A mounted detail owns its subscription, but never owns backend capture. */
export function usePerceptionSource(
  source: ReturnType<typeof createPerceptionSourceState>,
) {
  const store = useStore();
  useEffect(() => {
    const stop = subscribePerception(
      (snapshot) => {
        store.set(
          source.sourceAtom,
          snapshot.sources.find(
            (item) =>
              item.source.deviceId === source.target.deviceId &&
              item.source.channel === source.target.channel,
          ),
        );
        store.set(source.connectedAtom, true);
      },
      () => {
        store.set(source.connectedAtom, false);
      },
    );
    return () => {
      stop();
      store.set(source.sourceAtom, undefined);
    };
  }, [store, source]);
}
