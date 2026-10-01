import { atom } from "jotai";
import { atomWithLazy } from "jotai/utils";

const backgroundReleaseDelayMs = 15_000;
const pageActiveAtom = atomWithLazy(
  () => document.visibilityState === "visible",
);

pageActiveAtom.onMount = (setActive) => {
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  const updateVisibility = () => {
    clearTimeout(releaseTimer);
    if (document.visibilityState === "visible") {
      setActive(true);
    } else {
      releaseTimer = setTimeout(() => {
        if (document.visibilityState !== "visible") setActive(false);
      }, backgroundReleaseDelayMs);
    }
  };
  document.addEventListener("visibilitychange", updateVisibility);
  // Refresh the value when the video route subscribes again.
  setActive(document.visibilityState === "visible");
  return () => {
    document.removeEventListener("visibilitychange", updateVisibility);
    clearTimeout(releaseTimer);
  };
};

/** Playback stays active through brief page visibility interruptions. */
export const playbackPageActiveAtom = atom((get) => get(pageActiveAtom));
