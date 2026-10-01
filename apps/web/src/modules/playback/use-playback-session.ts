import { usePlaybackSessions } from "./playback-context";
import { useSetAtom } from "jotai";
import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { PlaybackSession, initialPlaybackSnapshot } from "./session";
import { createPlaybackStatusAtom, registerPlaybackAtom } from "./state";

const subscribeInitial = () => () => {};
const getInitialSnapshot = () => initialPlaybackSnapshot;

/** Both video and canvas viewers register the same lightweight playback status. */
export function usePlaybackSession({
  surface,
  target,
  onFrame,
  onStop,
}: {
  surface: RefObject<
    Parameters<PlaybackSession["attach"]>[0]["element"] | null
  >;
  target: ConstructorParameters<typeof PlaybackSession>[0] | null;
  onFrame?: Parameters<PlaybackSession["attach"]>[0]["onFrame"];
  onStop?: () => void;
}) {
  const sessions = usePlaybackSessions();
  const [session, setSession] = useState(() =>
    target ? (sessions.get(target) ?? null) : null,
  );
  const [attempt, setAttempt] = useState(0);
  const [statusAtom] = useState(createPlaybackStatusAtom);
  const setPhase = useSetAtom(statusAtom);
  const registerPlayback = useSetAtom(registerPlaybackAtom);
  const snapshot = useSyncExternalStore(
    session?.subscribe ?? subscribeInitial,
    session?.getSnapshot ?? getInitialSnapshot,
  );
  const deviceId = target?.deviceId;
  const channel = target?.channel;
  const scope_epoch = target?.scope_epoch;
  const revision = target?.revision;

  useEffect(() => {
    if (
      !surface.current ||
      !deviceId ||
      !channel ||
      !scope_epoch ||
      !revision
    ) {
      return undefined;
    }
    const lease = sessions.acquire({
      deviceId,
      channel,
      scope_epoch,
      revision,
    });
    const next = lease.session;
    const unsubscribe = next.subscribe(() => {
      setSession(next);
      setPhase(next.getSnapshot().phase);
    });
    const detach = next.attach({
      element: surface.current,
      ...(onFrame ? { onFrame } : {}),
    });
    setPhase(next.getSnapshot().phase);
    registerPlayback(statusAtom, true);
    next.start();
    return () => {
      unsubscribe();
      detach();
      registerPlayback(statusAtom, false);
      lease.release();
      onStop?.();
    };
  }, [
    sessions,
    surface,
    deviceId,
    channel,
    scope_epoch,
    revision,
    onFrame,
    onStop,
    statusAtom,
    setPhase,
    registerPlayback,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- An explicit retry owns a fresh viewer with the same target.
    attempt,
  ]);

  const restart = useCallback(() => {
    if (deviceId && channel && scope_epoch && revision)
      sessions.invalidate({ deviceId, channel, scope_epoch, revision });
    setAttempt((value) => value + 1);
  }, [sessions, deviceId, channel, scope_epoch, revision]);
  return {
    snapshot: target ? snapshot : initialPlaybackSnapshot,
    restart,
  };
}
