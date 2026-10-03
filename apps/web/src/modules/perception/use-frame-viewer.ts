import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue, useStore } from "jotai";
import { householdSyncedAtom } from "../household/state";
import { usePlaybackSession } from "../playback/use-playback-session";
import { playbackRetryDelay } from "../playback/retry";
import { createFramePresentation } from "./presentation";
import type { createPerceptionSourceState } from "./source-state";

/** Owns the canvas view across short-lived playback connections and frozen inspection. */
export function useFrameViewer(
  source: ReturnType<typeof createPerceptionSourceState>,
) {
  const store = useStore();
  const target = useAtomValue(source.playbackTargetAtom);
  const canvas = useRef<HTMLCanvasElement>(null);
  const display = useRef<ReturnType<typeof createFramePresentation> | null>(
    null,
  );
  const [view, setView] =
    useState<ReturnType<NonNullable<typeof display.current>["snapshot"]>>();
  const [inspection, setInspection] = useState<ReturnType<typeof inspect>>();
  const [watching, setWatching] = useState(
    () => document.visibilityState === "visible",
  );

  useEffect(() => {
    if (!canvas.current) return undefined;
    const presentation = createFramePresentation(canvas.current, () => {
      setView(presentation.snapshot());
    });
    display.current = presentation;
    const update = () => {
      if (store.get(source.revokedAtom)) {
        presentation.revoke();
        setInspection(undefined);
        return;
      }
      presentation.update(store.get(source.activeSourceAtom));
    };
    const unsubscribe = store.sub(source.activeSourceAtom, update);
    const unsubscribeAccess = store.sub(source.revokedAtom, update);
    update();
    return () => {
      unsubscribe();
      unsubscribeAccess();
      display.current = null;
      presentation.close();
    };
  }, [store, source]);

  const onFrame = useCallback<
    NonNullable<Parameters<typeof usePlaybackSession>[0]["onFrame"]>
  >(
    (frame) => {
      // Read current eligibility at the frame boundary, without waiting for a React effect.
      if (!store.get(source.playbackTargetAtom)) return;
      display.current?.capture(frame);
      display.current?.update(store.get(source.activeSourceAtom));
    },
    [store, source],
  );
  const onStop = useCallback(() => {
    display.current?.suspend();
  }, []);
  const { snapshot, restart } = usePlaybackSession({
    surface: canvas,
    target: watching ? target : null,
    onFrame,
    onStop,
  });
  const retries = useRef(0);
  useEffect(() => {
    retries.current = 0;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A different viewing scope or manual resume starts a fresh retry budget.
  }, [target?.scope_epoch, target?.revision, watching]);
  useEffect(() => {
    if (snapshot.phase === "playing") retries.current = 0;
    if (!watching || !target || snapshot.phase !== "error") return undefined;
    const delay = playbackRetryDelay(snapshot.failure, retries.current);
    if (delay === undefined) return undefined;
    const timer = setTimeout(() => {
      retries.current++;
      restart();
    }, delay);
    return () => clearTimeout(timer);
  }, [watching, target, snapshot.phase, snapshot.failure, restart]);

  const ready = !!target;
  const inspect = useCallback(() => {
    const live = watching && ready && !display.current?.snapshot().frozen;
    const accessible = store.get(source.accessibleAtom);
    return {
      sampledAt: new Date().toISOString(),
      streamReady: store.get(source.connectedAtom),
      householdSynced: store.get(householdSyncedAtom),
      playbackPhase: live ? snapshot.phase : null,
      playbackId: live ? snapshot.playbackId : null,
      source: accessible
        ? {
            ...source.target,
            analysis: store.get(source.activeSourceAtom) ?? null,
            audio: store.get(source.audioAtom),
          }
        : null,
      presentation: accessible ? display.current?.inspect() : null,
      failure: view?.failure ?? null,
    };
  }, [
    store,
    source,
    watching,
    ready,
    snapshot.phase,
    snapshot.playbackId,
    view?.failure,
  ]);

  const freeze = useCallback(() => {
    const presentation = display.current;
    if (!presentation || presentation.snapshot().frozen) return;
    presentation.freeze();
    setInspection(inspect());
    setWatching(false);
  }, [inspect]);

  useEffect(() => {
    const visibility = () => {
      if (document.visibilityState !== "visible") freeze();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, [freeze]);

  return {
    canvas,
    inspection,
    inspect,
    view,
    snapshot,
    watching,
    ready,
    freeze,
    retry: () => {
      retries.current = 0;
      restart();
    },
    live: () => {
      display.current?.live();
      setInspection(undefined);
      setWatching(true);
    },
  };
}
