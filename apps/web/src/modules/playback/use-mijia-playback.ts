import { useRef } from "react";
import { usePlaybackSession } from "./use-playback-session";

export function useMijiaPlayback(
  target: NonNullable<Parameters<typeof usePlaybackSession>[0]["target"]>,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { snapshot } = usePlaybackSession({ surface: videoRef, target });
  return { videoRef, snapshot };
}
