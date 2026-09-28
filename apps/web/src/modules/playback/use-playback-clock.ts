import { useEffect, useState } from "react";

function readClock() {
  return { monotonicMs: performance.now(), wallMs: Date.now() };
}

/** Mounted only for a visible startup; remounting reads the clock before paint. */
export function usePlaybackClock(startedAt: number | null) {
  const [clock, setClock] = useState(readClock);
  useEffect(() => {
    if (startedAt === null) return undefined;
    let timer: ReturnType<typeof setTimeout>;
    function schedule() {
      const current = performance.now();
      const nextSecondMs = 1_000 - ((current - startedAt!) % 1_000);
      timer = setTimeout(
        () => {
          setClock(readClock());
          schedule();
        },
        Math.max(1, nextSecondMs),
      );
    }
    schedule();
    return () => clearTimeout(timer);
  }, [startedAt]);
  return clock;
}
