import type { z } from "zod";
import type {
  identityReferenceSnapshotSchema,
  identityMatchProvenanceSchema,
  trackingObservationSchema,
  identityObservationSchema,
} from "@home-agent/api/contracts";
import { identityLimits, type identityConfigSchema } from "./config";
import { createReferences } from "./references";
import type { identityEvidenceSchema } from "./evidence";

function sampleEvidence(
  sample: z.infer<typeof identityEvidenceSchema>["samples"][number],
  references: ReturnType<typeof createReferences> | null,
  snapshot: z.infer<typeof identityReferenceSnapshotSchema>,
  provenance: z.infer<typeof identityMatchProvenanceSchema>,
  clock: number,
  at: number,
) {
  const scores = references?.rank(sample.feature, sample.className) ?? [];
  const best = scores[0];
  const margin = best ? best.score - (scores[1]?.score ?? -1) : null;
  const label =
    best &&
    references &&
    best.score >= best.threshold &&
    margin !== null &&
    margin > best.margin &&
    snapshot.members.some(
      (member) => member.memberId === best.label && member.enabled,
    )
      ? best.label
      : null;
  return {
    clock,
    at,
    cropSha256: sample.cropSha256,
    provenance,
    scores,
    label,
    reason:
      best &&
      best.score >= best.threshold &&
      margin !== null &&
      margin > best.margin &&
      !snapshot.members.some(
        (member) => member.memberId === best.label && member.enabled,
      )
        ? "reference_disabled"
        : "below_identity_threshold",
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
  initialReferences: z.infer<typeof identityReferenceSnapshotSchema> | null,
) {
  let snapshot = initialReferences;
  let references = snapshot ? createReferences(snapshot) : null;
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
          ? "conflicting_identity_evidence"
          : track.confirmedLabel
            ? "repeated_identity_support"
            : label
              ? "insufficient_support"
              : latest
                ? latest.reason
                : "no_fresh_identity_sample",
      samples: track.samples.length,
      supportingSamples: supporting.length,
      score: best?.score ?? null,
      margin: best ? best.score - (scores[1]?.score ?? -1) : null,
      firstSeenAt: track.firstSeenAt,
      lastSeenAt: track.lastSeenAt,
      lastEvidenceAt: latest?.at ?? null,
      evidence: track.samples.map((sample) => ({
        provenance: sample.provenance,
        observedAt: sample.at,
        label: sample.label,
        bestMemberId: sample.scores[0]?.label ?? null,
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
    replaceReferences(
      next: z.infer<typeof identityReferenceSnapshotSchema> | null,
    ) {
      snapshot = next;
      references = next ? createReferences(next) : null;
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
      const activeIds = new Set(
        input
          .filter((track) => references?.hasCandidates(track.className))
          .map((track) => track.trackId),
      );
      for (const [id, track] of tracks) {
        if (!activeIds.has(id)) {
          recent.push({ clock, value: { ...describe(track), endedAt: at } });
          tracks.delete(id);
        }
      }
      for (const inputTrack of input) {
        if (
          !references?.hasCandidates(inputTrack.className) ||
          inputTrack.state !== "measured"
        )
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
            references?.hasCandidates(track.className) &&
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
        .slice(0, identityLimits.targetsPerFrame)
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
      observation: z.infer<typeof trackingObservationSchema>,
      clock: number,
      at: number,
    ) {
      if (!snapshot) return;
      prune(clock);
      statistics.qualityRejected += result.qualityRejected;
      for (const sample of result.samples) {
        const track = tracks.get(sample.trackId);
        if (
          !track ||
          !observation.tracks.some(
            (target) =>
              target.trackId === sample.trackId &&
              target.className === sample.className,
          )
        )
          continue;
        if (
          track.samples.some(
            (previous) => previous.cropSha256 === sample.cropSha256,
          )
        ) {
          statistics.duplicateSamples++;
          continue;
        }
        const provenance = {
          revision: snapshot.revision,
          modelVersion: snapshot.modelVersion,
          processingVersion: snapshot.processingVersion,
          evidenceKey: `${observation.run.runId}:${observation.mediaTime.generation}:${observation.mediaTime.rtpTimestamp}:${sample.trackId}`,
          sourceRunId: observation.run.runId,
          sequence: observation.sequence,
          mediaGeneration: observation.mediaTime.generation,
          rtpTimestamp: observation.mediaTime.rtpTimestamp,
          trackId: sample.trackId,
        };
        const evidence = sampleEvidence(
          sample,
          references,
          snapshot,
          provenance,
          clock,
          at,
        );
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
