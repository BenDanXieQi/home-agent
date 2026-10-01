import { createPetTracker } from "./pet-tracker";
import { createTrackIds } from "./track-ids";
import type { z } from "zod";
import type { trackingObservationSchema } from "@home-agent/api/contracts";
import type { VideoFrame } from "../media/latest-frame";
import type { observationSchema, runSchema } from "../observations";
import { createHumanTracker } from "./tracker";
import type { createReidProcess } from "./reid-process";

function metadata(run: z.infer<typeof runSchema>, frame: VideoFrame) {
  return {
    run,
    sequence: frame.sequence,
    receivedAt: frame.receivedAt,
    sampledAt: frame.receivedAt,
    mediaTime: frame.mediaTime,
    ageMs: Math.max(0, performance.now() - frame.availableAt),
    width: frame.width,
    height: frame.height,
    coordinateBasis: "decoded_rgb24" as const,
  };
}
function createRunState() {
  const allocateId = createTrackIds();
  return {
    tracker: createHumanTracker(allocateId),
    pets: createPetTracker(allocateId),
    busy: false,
    skipped: 0,
    width: 0,
    height: 0,
    times: new Map<
      number,
      {
        measuredClock: number;
        measuredAt: number;
        featureClock: number | null;
        featureAt: number | null;
      }
    >(),
    release: undefined as (() => void) | undefined,
  };
}
export function createTrackingRuntime(options: {
  reserveCompute: () => boolean;
  model: ReturnType<typeof createReidProcess>;
  emit: (
    observation: z.infer<typeof trackingObservationSchema>,
  ) => Promise<void>;
  failure: (error: unknown) => void;
}) {
  const model = options.model;
  const runs = new Map<string, ReturnType<typeof createRunState>>();
  const pending = new Set<Promise<void>>();
  // FIFO eligibility contains only source IDs and expires when input stops.
  const pixelTurns = new Map<string, number>();
  let retained = 0;
  let closed = false;

  return {
    start(run: z.infer<typeof runSchema>) {
      runs.set(run.runId, createRunState());
    },
    stop(runId: string) {
      runs.get(runId)?.release?.();
      runs.delete(runId);
      pixelTurns.delete(runId);
    },
    capture(
      run: z.infer<typeof runSchema>,
      frame: VideoFrame,
      maxAgeMs: number,
    ) {
      const entry = runs.get(run.runId);
      if (!entry || closed) return undefined;
      if (entry.busy) {
        entry.skipped++;
        return undefined;
      }
      entry.busy = true;
      const now = performance.now();
      for (const [id, expiresAt] of pixelTurns) {
        if (expiresAt <= now) pixelTurns.delete(id);
      }
      if (now - frame.availableAt < maxAgeMs)
        pixelTurns.set(run.runId, frame.availableAt + maxAgeMs);
      const hasPixels =
        retained < 2 &&
        pixelTurns.keys().next().value === run.runId &&
        now - frame.availableAt < maxAgeMs;
      // Geometry needs no pixels. Only appearance owns a bounded independent
      // copy, because detection transfers the original buffer to Piscina.
      let rgb = hasPixels ? new Uint8Array(frame.rgb) : undefined;
      if (hasPixels) {
        retained++;
        pixelTurns.delete(run.runId);
      }
      function releasePixels() {
        if (!rgb) return;
        rgb = undefined;
        retained--;
      }
      let released = false;
      const expiry = hasPixels
        ? setTimeout(
            releasePixels,
            Math.max(1, maxAgeMs - (now - frame.availableAt)),
          )
        : undefined;
      function release() {
        if (released) return;
        released = true;
        clearTimeout(expiry);
        releasePixels();
        entry!.busy = false;
        entry!.release = undefined;
      }
      entry.release = release;
      return {
        release,
        complete(detections: z.infer<typeof observationSchema>["detections"]) {
          const task = (async () => {
            let tracks: z.infer<typeof trackingObservationSchema>["tracks"] =
              [];
            let status: z.infer<typeof trackingObservationSchema>["status"] =
              "tracked";
            let reason: string | undefined;
            try {
              if (runs.get(run.runId) !== entry || closed) return;
              if (
                released ||
                performance.now() - frame.availableAt >= maxAgeMs
              ) {
                entry.skipped++;
                return;
              }
              if (
                entry.width !== frame.width ||
                entry.height !== frame.height
              ) {
                entry.tracker.reset();
                entry.pets.reset();
                entry.times.clear();
                entry.width = frame.width;
                entry.height = frame.height;
              }
              const input = entry.tracker.begin(frame.availableAt, detections);
              const features = input.cached.map(
                (cached) => cached?.vector ?? null,
              );
              const missing = input.humans.flatMap((_, i) =>
                features[i] ? [] : [i],
              );
              if (missing.length) {
                if (options.reserveCompute()) model.start();
                if (!rgb || !model.status.ready || model.status.busy) {
                  status = "degraded";
                  reason = !rgb
                    ? "Appearance frame capacity unavailable"
                    : (model.status.error ??
                      "Appearance compute unavailable or busy");
                } else {
                  try {
                    const result = await model.extract(
                      {
                        frame: {
                          width: frame.width,
                          height: frame.height,
                          rgb,
                        },
                        boxes: missing.map((i) => input.humans[i]!),
                      },
                      Math.max(
                        1,
                        Math.min(
                          1000,
                          maxAgeMs - (performance.now() - frame.availableAt),
                        ),
                      ),
                    );
                    if (result.length !== missing.length)
                      throw new Error("ReID result count mismatch");
                    for (const [i, index] of missing.entries())
                      features[index] = result[i]!;
                  } catch (error) {
                    status = "degraded";
                    reason = String(error).slice(0, 4096);
                  }
                }
              }
              tracks = [
                ...entry.tracker.finish(input, features),
                ...entry.pets.update(frame.availableAt, detections),
              ].map((track) => {
                const previous = entry.times.get(track.trackId);
                // Preserve the original frame's host time when predicting or
                // reusing a feature, even if the system clock has been corrected.
                const times = {
                  measuredClock: track.lastMeasuredAt,
                  measuredAt:
                    previous?.measuredClock === track.lastMeasuredAt
                      ? previous.measuredAt
                      : frame.receivedAt,
                  featureClock: track.featureAt,
                  featureAt:
                    track.featureAt === null
                      ? null
                      : previous?.featureClock === track.featureAt
                        ? previous.featureAt
                        : frame.receivedAt,
                };
                entry.times.set(track.trackId, times);
                return {
                  ...track,
                  lastMeasuredAt: times.measuredAt,
                  featureAt: times.featureAt,
                };
              });
              const activeIds = new Set(tracks.map((track) => track.trackId));
              for (const id of entry.times.keys()) {
                if (!activeIds.has(id)) entry.times.delete(id);
              }
            } catch (error) {
              status = "failed";
              reason = String(error).slice(0, 4096);
              entry.tracker.reset();
              entry.pets.reset();
              entry.times.clear();
            } finally {
              release();
            }
            if (
              runs.get(run.runId) !== entry ||
              closed ||
              performance.now() - frame.availableAt >= maxAgeMs
            )
              return;
            await options.emit({
              ...metadata(run, frame),
              tracks,
              status,
              reason,
              skippedFrames: entry.skipped,
              omittedPets: Math.max(
                0,
                detections.filter(
                  (d) =>
                    (d.className === "cat" || d.className === "dog") &&
                    d.confidence >= 0.5,
                ).length -
                  tracks.filter(
                    (track) =>
                      track.className !== "human" && track.state === "measured",
                  ).length,
              ),
              omittedHumans: Math.max(
                0,
                detections.filter(
                  (d) => d.className === "human" && d.confidence >= 0.5,
                ).length -
                  tracks.filter(
                    (track) =>
                      track.className === "human" && track.state === "measured",
                  ).length,
              ),
            });
          })().catch(options.failure);
          pending.add(task);
          task.then(() => {
            pending.delete(task);
          }, options.failure);
        },
      };
    },
    async close() {
      closed = true;
      for (const entry of runs.values()) entry.release?.();
      runs.clear();
      pixelTurns.clear();
      await model.close();
      await Promise.all(pending);
    },
  };
}
