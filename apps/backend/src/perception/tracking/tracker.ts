import { createTrackIds } from "./track-ids";
import type { z } from "zod";
import type { detectionSchema } from "../observations";
import { assign, iou } from "./assignment";
import { initiate, predict, correct, distance, predictedBox } from "./kalman";

type Detection = z.infer<typeof detectionSchema>;
const cosine = (gallery: number[][], vector: number[]) =>
  Math.min(
    ...gallery.map((item) =>
      Math.max(
        0,
        1 - item.reduce((sum, value, i) => sum + value * vector[i]!, 0),
      ),
    ),
  );
export function createHumanTracker(allocateId = createTrackIds()) {
  let step = 0;
  let time = -Infinity;
  let tracks: ReturnType<typeof newTrack>[] = [];
  function newTrack(detection: Detection, at: number) {
    return {
      id: allocateId(),
      state: initiate(detection),
      box: detection,
      lastSeen: at,
      lastStep: step,
      hits: 1,
      static: false,
      features: [] as number[][],
      featureStep: -Infinity,
      featureAt: null as number | null,
    };
  }
  function begin(at: number, detections: Detection[]) {
    if (!Number.isFinite(at) || at <= time)
      throw new Error("Tracking time must increase");
    tracks = tracks.filter((track) => at - track.lastSeen <= 2000);
    for (const track of tracks) predict(track.state, (at - time) / 1000);
    time = at;
    step++;
    const humans = detections
      .filter((d) => d.className === "human" && d.confidence >= 0.5)
      .toSorted((a, b) => b.confidence - a.confidence)
      .slice(0, 8);
    const cached = humans.map(
      () => null as { vector: number[]; trackId: number; at: number } | null,
    );
    // Cache only unambiguous, static, immediately preceding observations.
    for (const [ti, di] of assign(
      tracks.map((t) => humans.map((d) => 1 - iou(t.box, d))),
      0.7,
    )) {
      const t = tracks[ti]!;
      if (
        !t.static ||
        t.lastStep !== step - 1 ||
        step - t.featureStep >= 4 ||
        t.featureAt === null
      )
        continue;
      const d = humans[di]!;
      const displacement = Math.hypot(
        d.x + d.w / 2 - t.box.x - t.box.w / 2,
        d.y + d.h / 2 - t.box.y - t.box.h / 2,
      );
      if (
        displacement >= Math.min(10, Math.hypot(d.w, d.h) * 0.05) ||
        tracks.some((other) => other !== t && iou(other.box, d) >= 0.3) ||
        humans.some((other) => other !== d && iou(t.box, other) >= 0.3)
      )
        continue;
      const vector = t.features.at(-1);
      if (vector) cached[di] = { vector, trackId: t.id, at: t.featureAt };
    }
    return { humans, cached, step };
  }
  function finish(
    input: ReturnType<typeof begin>,
    features: (number[] | null)[],
  ) {
    if (input.step !== step || features.length !== input.humans.length)
      throw new Error("Stale tracking update");
    const remaining = new Set(input.humans.map((_, i) => i));
    const matched = new Map<number, number>();
    // Cascade by actual last observation time, then solve globally within each age group.
    for (const seen of [...new Set(tracks.map((t) => t.lastSeen))].toSorted(
      (a, b) => b - a,
    )) {
      const group = tracks.filter((t) => t.lastSeen === seen);
      const indices = [...remaining];
      const costs = group.map((t) =>
        indices.map((i) => {
          const feature = features[i];
          const cached = input.cached[i];
          return feature &&
            t.features.length &&
            (!cached || cached.trackId === t.id) &&
            distance(t.state, input.humans[i]!) <= 9.4877
            ? cosine(t.features, feature)
            : Infinity;
        }),
      );
      for (const [ti, di] of assign(costs, 0.2)) {
        const index = indices[di]!;
        matched.set(group[ti]!.id, index);
        remaining.delete(index);
      }
    }
    const recent = tracks.filter(
      (t) => !matched.has(t.id) && t.lastStep === step - 1,
    );
    const indices = [...remaining];
    const costs = recent.map((t) =>
      indices.map((i) => {
        const cached = input.cached[i];
        return cached && cached.trackId !== t.id
          ? Infinity
          : 1 - iou(predictedBox(t.state), input.humans[i]!);
      }),
    );
    for (const [ti, di] of assign(costs, 0.7)) {
      const index = indices[di]!;
      matched.set(recent[ti]!.id, index);
      remaining.delete(index);
    }
    function retainFeature(track: (typeof tracks)[number], index: number) {
      const vector = features[index];
      if (!vector || input.cached[index]) return;
      if (
        vector.length !== 128 ||
        vector.some((v) => !Number.isFinite(v)) ||
        Math.abs(Math.hypot(...vector) - 1) > 0.001
      )
        throw new Error("Invalid normalized appearance feature");
      track.features.push(vector);
      track.features = track.features.slice(-50);
      track.featureStep = step;
      track.featureAt = time;
    }
    for (const t of tracks) {
      const index = matched.get(t.id);
      if (index === undefined) continue;
      const d = input.humans[index]!;
      const displacement = Math.hypot(
        d.x + d.w / 2 - t.box.x - t.box.w / 2,
        d.y + d.h / 2 - t.box.y - t.box.h / 2,
      );
      t.static =
        displacement < 10 && displacement < Math.hypot(d.w, d.h) * 0.05;
      correct(t.state, d);
      t.box = d;
      t.lastSeen = time;
      t.lastStep = step;
      t.hits++;
      retainFeature(t, index);
    }
    for (const index of remaining) {
      if (tracks.length >= 8) break;
      const track = newTrack(input.humans[index]!, time);
      retainFeature(track, index);
      tracks.push(track);
      matched.set(track.id, index);
    }
    return tracks.map((t) => {
      const index = matched.get(t.id);
      return {
        trackId: t.id,
        className: "human" as const,
        state:
          index === undefined ? ("predicted" as const) : ("measured" as const),
        measuredBox: index === undefined ? null : t.box,
        predictedBox: predictedBox(t.state),
        lastMeasuredAt: t.lastSeen,
        hits: t.hits,
        feature:
          index === undefined || !features[index]
            ? ("missing" as const)
            : input.cached[index]
              ? ("reused" as const)
              : ("extracted" as const),
        featureAt: t.featureAt,
      };
    });
  }
  return {
    begin,
    finish,
    reset() {
      tracks = [];
      time = -Infinity;
      step = 0;
    },
  };
}
