import { z } from "zod";
import type { detectionSchema } from "../observations";
import { assign, iou } from "./assignment";
import { initiate, predict, correct, distance, predictedBox } from "./kalman";
import { createTrackIds } from "./track-ids";

export const petTrackingPolicySchema = z.object({
  continuationConfidence: z.number().min(0.1).max(0.5).default(0.5),
  newTrackConfidence: z.number().min(0.5).max(1).default(0.5),
  confirmationHits: z.int().min(1).max(3).default(1),
});

// Pets use motion and overlap only; the human appearance model is not a pet
// identity model. The two species share eight slots but can never match each other.
export function createPetTracker(
  allocateId = createTrackIds(),
  input: z.input<typeof petTrackingPolicySchema> = {},
) {
  const policy = petTrackingPolicySchema.parse(input);
  let time = -Infinity;
  let tracks: ReturnType<typeof newTrack>[] = [];
  function newTrack(
    box: z.infer<typeof detectionSchema>,
    className: "cat" | "dog",
    at: number,
  ) {
    return {
      id: allocateId(),
      className,
      box,
      motion: initiate(box),
      lastSeen: at,
      hits: 1,
      confirmations: [true],
      confirmed: policy.confirmationHits === 1,
    };
  }
  return {
    update(at: number, detections: z.infer<typeof detectionSchema>[]) {
      if (!Number.isFinite(at) || at <= time)
        throw new Error("Tracking time must increase");
      tracks = tracks.filter((track) => at - track.lastSeen <= 2000);
      for (const track of tracks) predict(track.motion, (at - time) / 1000);
      time = at;
      const candidates = detections
        .filter(
          (box) =>
            (box.className === "cat" || box.className === "dog") &&
            box.confidence >= policy.continuationConfidence,
        )
        .toSorted((a, b) => b.confidence - a.confidence);
      // High-confidence matches always take precedence. Weak candidates can
      // continue a confirmed trajectory, but never create or confirm one.
      const high = candidates
        .filter((box) => box.confidence >= 0.5)
        .slice(0, 8);
      const weak = candidates.filter((box) => box.confidence < 0.5).slice(0, 8);
      const pets = [...high, ...weak];
      const matched = new Set<number>();
      const associations = new Map<number, number>();
      for (const highPass of [true, false]) {
        const eligible = tracks.filter(
          (track) =>
            !associations.has(track.id) && (highPass || track.confirmed),
        );
        const indices = pets.flatMap((box, index) =>
          box.confidence >= 0.5 === highPass ? [index] : [],
        );
        for (const [ti, di] of assign(
          eligible.map((track) =>
            indices.map((index) => {
              const box = pets[index]!;
              return track.className === box.className &&
                distance(track.motion, box) <= 9.4877
                ? 1 - iou(predictedBox(track.motion), box)
                : Infinity;
            }),
          ),
          0.7,
        )) {
          const index = indices[di]!;
          associations.set(eligible[ti]!.id, index);
          matched.add(index);
        }
      }
      for (const track of tracks) {
        const index = associations.get(track.id);
        const box = index === undefined ? undefined : pets[index];
        track.confirmations = [
          ...track.confirmations,
          !!box && box.confidence >= 0.5,
        ].slice(-3);
        track.confirmed ||=
          track.confirmations.filter(Boolean).length >= policy.confirmationHits;
        if (!box) continue;
        correct(track.motion, box);
        track.box = box;
        track.lastSeen = at;
        track.hits++;
      }
      tracks = tracks.filter(
        (track) =>
          track.confirmed || track.confirmations.slice(-2).some(Boolean),
      );
      for (const [index, box] of pets.entries()) {
        if (tracks.length >= 8) break;
        if (matched.has(index) || box.confidence < policy.newTrackConfidence)
          continue;
        if (box.className === "cat" || box.className === "dog")
          tracks.push(newTrack(box, box.className, at));
      }
      return tracks
        .filter((track) => track.confirmed)
        .map((track) => ({
          trackId: track.id,
          className: track.className,
          state:
            track.lastSeen === at
              ? ("measured" as const)
              : ("predicted" as const),
          measuredBox: track.lastSeen === at ? track.box : null,
          predictedBox: predictedBox(track.motion),
          lastMeasuredAt: track.lastSeen,
          hits: track.hits,
          feature: "not_applicable" as const,
          featureAt: null,
        }));
    },
    reset() {
      tracks = [];
      time = -Infinity;
    },
  };
}
