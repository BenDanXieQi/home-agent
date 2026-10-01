import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue, useStore } from "jotai";
import { householdSyncedAtom } from "../household/state";
import { usePlaybackSession } from "../playback/use-playback-session";
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
      presentation.update(store.get(source.activeSourceAtom));
    };
    const unsubscribe = store.sub(source.activeSourceAtom, update);
    update();
    const visibility = () => {
      if (document.visibilityState !== "visible") {
        presentation.freeze();
        setWatching(false);
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      unsubscribe();
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
  useEffect(() => {
    if (!watching || !target || snapshot.phase !== "error") return undefined;
    const timer = setTimeout(restart, 2000);
    return () => clearTimeout(timer);
  }, [watching, target, snapshot.phase, restart]);

  return {
    canvas,
    view,
    snapshot,
    watching,
    ready: !!target,
    freeze: () => {
      display.current?.freeze();
      setWatching(false);
    },
    live: () => {
      display.current?.live();
      setWatching(true);
    },
    inspect: () => ({
      sampledAt: new Date().toISOString(),
      streamReady: store.get(source.connectedAtom),
      householdSynced: store.get(householdSyncedAtom),
      playbackPhase: watching && target ? snapshot.phase : null,
      playbackId: watching && target ? snapshot.playbackId : null,
      source: store.get(source.accessibleAtom)
        ? { ...source.target, analysis: store.get(source.sourceAtom) ?? null }
        : null,
      presentation: store.get(source.accessibleAtom)
        ? display.current?.inspect()
        : null,
      failure: view?.failure ?? null,
    }),
  };
}
