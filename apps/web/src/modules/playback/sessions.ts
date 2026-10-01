import { PlaybackSession } from "./session";

// Outside analysis, only bridge a route handoff; scrolling does not build a stream cache.
const handoffMs = 1000;
const targetKey = (target: ConstructorParameters<typeof PlaybackSession>[0]) =>
  JSON.stringify([
    target.scope_epoch,
    target.revision,
    target.deviceId,
    target.channel,
  ]);

export function createPlaybackSessions() {
  const entries = new Map<
    string,
    {
      target: ConstructorParameters<typeof PlaybackSession>[0];
      session: PlaybackSession;
      users: number;
      releaseTimer?: ReturnType<typeof setTimeout>;
    }
  >();
  let analysisActive = false;
  const wallConnections = new Set<string>();
  function queueRelease(key: string) {
    const entry = entries.get(key);
    if (!entry) return;
    clearTimeout(entry.releaseTimer);
    if (entry.users || wallConnections.has(key)) return;
    entry.releaseTimer = setTimeout(() => {
      if (
        entries.get(key) === entry &&
        !entry.users &&
        !wallConnections.has(key)
      )
        remove(key);
    }, handoffMs);
  }
  function remove(key: string) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    wallConnections.delete(key);
    clearTimeout(entry.releaseTimer);
    entry.session.stop();
  }
  return {
    get(target: ConstructorParameters<typeof PlaybackSession>[0]) {
      const session = entries.get(targetKey(target))?.session;
      return session?.stopped ? undefined : session;
    },
    setAnalysisActive(active: boolean) {
      if (active === analysisActive) return;
      analysisActive = active;
      if (active) {
        // Preserve only viewers already in use on the wall, not previously visited sources.
        for (const [key, entry] of entries) {
          if (entry.users && !entry.session.stopped) {
            wallConnections.add(key);
            clearTimeout(entry.releaseTimer);
          }
        }
      } else {
        wallConnections.clear();
        for (const key of entries.keys()) queueRelease(key);
      }
    },
    acquire(target: ConstructorParameters<typeof PlaybackSession>[0]) {
      const key = targetKey(target);
      if (entries.get(key)?.session.stopped) remove(key);
      let entry = entries.get(key);
      if (!entry) {
        entry = { target, session: new PlaybackSession(target), users: 0 };
        entries.set(key, entry);
      }
      clearTimeout(entry.releaseTimer);
      entry.users++;
      const owned = entry;
      return {
        session: entry.session,
        release() {
          if (entries.get(key) !== owned) return;
          owned.users--;
          queueRelease(key);
        },
      };
    },
    invalidate(target: ConstructorParameters<typeof PlaybackSession>[0]) {
      remove(targetKey(target));
    },
    retain(
      allowed: (
        target: ConstructorParameters<typeof PlaybackSession>[0],
      ) => boolean,
    ) {
      for (const [key, entry] of entries)
        if (!allowed(entry.target)) remove(key);
    },
    close() {
      for (const key of entries.keys()) remove(key);
    },
  };
}
