import { useSetAtom } from "jotai";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PlaybackSession, initialPlaybackSnapshot } from "./session";
import { createPlaybackStatusAtom, registerPlaybackAtom } from "./state";

const subscribeInitial = () => () => {};
const getInitialSnapshot = () => initialPlaybackSnapshot;

export function useMijiaPlayback({
  revision,
  scope_epoch,
  deviceId,
  channel,
}: ConstructorParameters<typeof PlaybackSession>[1]) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [session, setSession] = useState<PlaybackSession | null>(null);
  const [statusAtom] = useState(createPlaybackStatusAtom);
  const setPhase = useSetAtom(statusAtom);
  const registerPlayback = useSetAtom(registerPlaybackAtom);
  const snapshot = useSyncExternalStore(
    session?.subscribe ?? subscribeInitial,
    session?.getSnapshot ?? getInitialSnapshot,
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    const next = new PlaybackSession(video, {
      revision,
      scope_epoch,
      deviceId,
      channel,
    });
    const unsubscribe = next.subscribe(() =>
      setPhase(next.getSnapshot().phase),
    );
    setSession(next);
    registerPlayback(statusAtom, true);
    next.start();
    return () => {
      unsubscribe();
      registerPlayback(statusAtom, false);
      next.stop();
    };
  }, [
    revision,
    scope_epoch,
    deviceId,
    channel,
    statusAtom,
    setPhase,
    registerPlayback,
  ]);

  return { videoRef, snapshot };
}
