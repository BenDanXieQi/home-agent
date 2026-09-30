import type { createPetTracker } from "../../src/perception/tracking/pet-tracker";
import { iou } from "../../src/perception/tracking/assignment";

export function createTrackingMetrics(className: "cat" | "dog") {
  let previous: { id: number; at: number } | undefined;
  let visibleSince: number | undefined;
  let acquired = false;
  const stats = {
    frames: 0,
    visible: 0,
    matched: 0,
    switchesWithin2s: 0,
    missed: 0,
    wrongSpeciesAtTarget: 0,
    unmatchedMeasuredBoxes: 0,
    absentFrames: 0,
    absentWithMeasuredBoxes: 0,
    visibleEpisodes: 0,
    acquiredEpisodes: 0,
    acquisitionDelaysMs: [] as number[],
  };
  return {
    observe(
      at: number,
      target: Parameters<typeof iou>[0] | null,
      tracks: ReturnType<ReturnType<typeof createPetTracker>["update"]>,
    ) {
      stats.frames++;
      const measured = tracks.filter((t) => t.measuredBox !== null);
      if (!target) {
        stats.absentFrames++;
        if (measured.length) stats.absentWithMeasuredBoxes++;
        stats.unmatchedMeasuredBoxes += measured.length;
        visibleSince = undefined;
        acquired = false;
        return;
      }
      stats.visible++;
      if (visibleSince === undefined) {
        visibleSince = at;
        stats.visibleEpisodes++;
      }
      const matching = measured.filter(
        (t) => t.className === className && iou(t.measuredBox!, target) >= 0.5,
      );
      const found = matching.toSorted(
        (a, b) => iou(b.measuredBox!, target) - iou(a.measuredBox!, target),
      )[0];
      stats.unmatchedMeasuredBoxes += measured.length - (found ? 1 : 0);
      if (
        measured.some(
          (t) =>
            t.className !== className && iou(t.measuredBox!, target) >= 0.5,
        )
      )
        stats.wrongSpeciesAtTarget++;
      if (!found) {
        stats.missed++;
        return;
      }
      stats.matched++;
      if (previous && at - previous.at <= 2000 && previous.id !== found.trackId)
        stats.switchesWithin2s++;
      previous = { id: found.trackId, at };
      if (!acquired) {
        stats.acquisitionDelaysMs.push(at - visibleSince);
        stats.acquiredEpisodes++;
        acquired = true;
      }
    },
    result() {
      return {
        ...stats,
        unacquiredEpisodes: stats.visibleEpisodes - stats.acquiredEpisodes,
        matchRatio: stats.visible ? stats.matched / stats.visible : null,
      };
    },
  };
}
