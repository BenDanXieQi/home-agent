import { createContext, useContext } from "react";
import type { createPlaybackSessions } from "./sessions";

export const PlaybackContext = createContext<ReturnType<
  typeof createPlaybackSessions
> | null>(null);

export function usePlaybackSessions() {
  const sessions = useContext(PlaybackContext);
  if (!sessions) throw new Error("Playback requires the video route owner");
  return sessions;
}
