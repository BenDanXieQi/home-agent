import type { z } from "zod";
import type {
  trackingObservationSchema,
  identityObservationSchema,
} from "@home-agent/api/contracts";
import { identityLimits, type identityConfigSchema } from "./config";
import type { createReferences } from "./references";
import type { identityEvidenceSchema } from "./evidence";

function sampleEvidence(
  sample: z.infer<typeof identityEvidenceSchema>["samples"][number],
  references: ReturnType<typeof createReferences> | null,
  clock: number,
  at: number,
) {
  const scores = references?.rank(sample.feature) ?? [];
  const best = scores[0];
  const margin = best ? best.score - (scores[1]?.score ?? -1) : null;
  const label =
    best &&
    references &&
    best.score >= references.threshold &&
    margin !== null &&
    margin > references.margin
      ? best.label
      : null;
  return {
    clock,
    at,
    cropSha256: sample.cropSha256,
    scores,
    label,
    sharpness: sample.sharpness,
    detectionScore: sample.detectionScore,
  };
}
function newTrack(trackId: number, clock: number, at: number) {
  return {
    trackId,
    firstSeenClock: clock,
    firstSeenAt: at,
    lastSeenAt: at,
    attemptedAt: -Infinity,
    samples: [] as ReturnType<typeof sampleEvidence>[],
    confirmedLabel: null as string | null,
    confirmedAt: null as number | null,
    everConfirmed: false,
    conflict: false,
  };
}

// Owns only local identity evidence. Tracking owns geometry and track lifetimes.
export function createIdentityAnalysis(
  config: z.infer<typeof identityConfigSchema>,
  initialReferences: ReturnType<typeof createReferences> | null,
) {
  let references = initialReferences;
  const tracks = new Map<number, ReturnType<typeof newTrack>>();
  const recent: {
    clock: number;
    value: z.infer<typeof identityObservationSchema>["recent"][number];
  }[] = [];
  const statistics = {
    frames: 0,
    sampledFrames: 0,
    skippedBusy: 0,
    skippedNoPixels: 0,
    skippedIncompleteTracking: 0,
    acceptedSamples: 0,
    duplicateSamples: 0,
    qualityRejected: 0,
    conflicts: 0,
    tracksSeen: 0,
    confirmedTracks: 0,
    confirmationDelayMsTotal: 0,
  };
  function prune(clock: number) {
    for (const track of tracks.values()) {
      track.samples = track.samples.filter(
        (sample) => clock - sample.clock < config.evidenceTtlMs,
      );
      if (!track.samples.some((sample) => sample.label !== null))
        track.conflict = false;
      if (
        !track.samples.some((sample) => sample.label === track.confirmedLabel)
      ) {
        track.confirmedLabel = null;
        track.confirmedAt = null;
      }
    }
    while (
      recent.length &&
      (clock - recent[0]!.clock >= identityLimits.recentTtlMs ||
        recent.length > identityLimits.recentTracks)
    )
      recent.shift();
  }
  function describe(track: ReturnType<typeof newTrack>) {
    const latest = track.samples.at(-1);
    const label =
      track.confirmedLabel ??
      track.samples.findLast((previous) => previous.label !== null)?.label ??
      null;
    const supporting = label
      ? track.samples.filter((sample) => sample.label === label)
      : [];
    const latestSupport = supporting.at(-1);
    const scores = (latestSupport ?? latest)?.scores ?? [];
    const best = scores[0];
    return {
      trackId: track.trackId,
      state: track.confirmedLabel
        ? ("confirmed" as const)
        : track.conflict
          ? ("conflict" as const)
          : label
            ? ("candidate" as const)
            : ("unknown" as const),
      label: track.conflict ? null : label,
      reason: !references
        ? "no_reference_gallery"
        : track.conflict
          ? "conflicting_face_evidence"
          : track.confirmedLabel
            ? "repeated_face_support"
            : label
              ? "insufficient_support"
              : latest
                ? "below_identity_threshold"
                : "no_fresh_face",
      samples: track.samples.length,
      supportingSamples: supporting.length,
      score: best?.score ?? null,
      margin: best ? best.score - (scores[1]?.score ?? -1) : null,
      firstSeenAt: track.firstSeenAt,
      lastSeenAt: track.lastSeenAt,
      lastEvidenceAt: latest?.at ?? null,
      evidence: track.samples.map((sample) => ({
        observedAt: sample.at,
        label: sample.label,
        score: sample.scores[0]?.score ?? null,
        margin: sample.scores[0]
          ? sample.scores[0].score - (sample.scores[1]?.score ?? -1)
          : null,
        detectionScore: sample.detectionScore,
        sharpness: sample.sharpness,
      })),
      confirmedAt: track.confirmedAt,
      expiresAt: latestSupport ? latestSupport.at + config.evidenceTtlMs : null,
    };
  }
  return {
    replaceReferences(next: ReturnType<typeof createReferences> | null) {
      references = next;
      for (const track of tracks.values()) {
        track.samples = [];
        track.confirmedLabel = null;
        track.confirmedAt = null;
        track.conflict = false;
      }
      recent.length = 0;
    },
    observe(
      input: z.infer<typeof trackingObservationSchema>["tracks"],
      clock: number,
      at: number,
    ) {
      prune(clock);
      statistics.frames++;
      const humanIds = new Set(
        input
          .filter((track) => track.className === "human")
          .map((track) => track.trackId),
      );
      for (const [id, track] of tracks) {
        if (!humanIds.has(id)) {
          recent.push({ clock, value: { ...describe(track), endedAt: at } });
          tracks.delete(id);
        }
      }
      for (const inputTrack of input) {
        if (inputTrack.className !== "human" || inputTrack.state !== "measured")
          continue;
        let track = tracks.get(inputTrack.trackId);
        if (!track && tracks.size < identityLimits.tracksPerRun) {
          track = newTrack(inputTrack.trackId, clock, at);
          tracks.set(inputTrack.trackId, track);
          statistics.tracksSeen++;
        }
        if (track) track.lastSeenAt = at;
      }
      prune(clock);
      return input
        .filter(
          (track) =>
            track.className === "human" &&
            track.state === "measured" &&
            track.measuredBox &&
            track.hits >= 2,
        )
        .filter(
          (track) =>
            clock - (tracks.get(track.trackId)?.attemptedAt ?? clock) >=
            config.sampleIntervalMs,
        )
        .toSorted(
          (a, b) =>
            tracks.get(a.trackId)!.attemptedAt -
            tracks.get(b.trackId)!.attemptedAt,
        )
        .slice(0, identityLimits.facesPerFrame)
        .map((track) => track.trackId);
    },
    admitted(ids: number[], clock: number) {
      statistics.sampledFrames++;
      for (const id of ids) {
        const track = tracks.get(id);
        if (track) track.attemptedAt = clock;
      }
    },
    skipped(reason: "busy" | "pixels" | "coverage") {
      if (reason === "busy") statistics.skippedBusy++;
      else if (reason === "pixels") statistics.skippedNoPixels++;
      else statistics.skippedIncompleteTracking++;
    },
    accept(
      result: z.infer<typeof identityEvidenceSchema>,
      clock: number,
      at: number,
    ) {
      prune(clock);
      statistics.qualityRejected += result.qualityRejected;
      for (const sample of result.samples) {
        const track = tracks.get(sample.trackId);
        if (!track) continue;
        if (
          track.samples.some(
            (previous) => previous.cropSha256 === sample.cropSha256,
          )
        ) {
          statistics.duplicateSamples++;
          continue;
        }
        const evidence = sampleEvidence(sample, references, clock, at);
        statistics.acceptedSamples++;
        const previousLabel =
          track.confirmedLabel ??
          track.samples.findLast((previous) => previous.label !== null)?.label;
        if (
          evidence.label &&
          previousLabel &&
          evidence.label !== previousLabel
        ) {
          track.samples = [];
          track.confirmedLabel = null;
          track.confirmedAt = null;
          track.conflict = true;
          statistics.conflicts++;
        }
        track.samples.push(evidence);
        track.samples = track.samples.slice(-identityLimits.samplesPerTrack);
        const supporting = evidence.label
          ? track.samples.filter((item) => item.label === evidence.label)
          : [];
        if (
          supporting.length >= identityLimits.minimumConfirmations &&
          clock - supporting[0]!.clock >= 2 * config.sampleIntervalMs
        ) {
          track.confirmedLabel = evidence.label;
          track.confirmedAt ??= at;
          track.conflict = false;
          if (!track.everConfirmed) {
            track.everConfirmed = true;
            statistics.confirmedTracks++;
            statistics.confirmationDelayMsTotal += clock - track.firstSeenClock;
          }
        }
      }
    },
    snapshot(clock: number) {
      prune(clock);
      return {
        tracks: [...tracks.values()].map(describe),
        recent: recent.map((item) => item.value),
        statistics: { ...statistics },
      };
    },
  };
}
