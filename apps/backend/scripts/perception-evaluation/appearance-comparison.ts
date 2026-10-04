import { createAppearanceIdentity } from "../../src/household/identity/appearance";

function newTiming() {
  return {
    count: 0,
    totalMs: 0,
    minMs: null as number | null,
    maxMs: null as number | null,
  };
}
function addTiming(state: ReturnType<typeof newTiming>, value: number) {
  state.count++;
  state.totalMs += value;
  state.minMs = Math.min(state.minMs ?? value, value);
  state.maxMs = Math.max(state.maxMs ?? value, value);
}
// Real evidence is shared across these isolated domains; no replayed pixels or model calls.
export function createAppearanceComparison(
  matching: Parameters<typeof createAppearanceIdentity>[0]["matching"],
) {
  const variants = [60_000, 300_000, 600_000].flatMap((referenceTtlMs) =>
    [1000, 3000, 5000].map((supportWindowMs) => {
      const policy = {
        policyVersion: `public-diagnostic-real28-0.94-0.13-ref${referenceTtlMs}-support${supportWindowMs}`,
        threshold: 0.94,
        margin: 0.13,
        referenceTtlMs,
        supportWindowMs,
        inferenceTtlMs: 5000,
      };
      const domain = createAppearanceIdentity({
        matching,
        calibration: policy,
      });
      return {
        policy,
        domain,
        tracks: new Map<
          number,
          {
            inferred: boolean;
            candidateAt: number | null;
            lossAt: number | null;
          }
        >(),
        statistics: {
          observations: 0,
          eligibleOnsets: 0,
          failedEligibleOnsets: 0,
          completedEligibleOnsets: 0,
          formationsWithoutEligibleOnset: 0,
          failedReasons: new Map<string, number>(),
          inferredObservations: 0,
          formations: 0,
          lossWhileActive: 0,
          reacquisitions: 0,
          unrecoveredLossesTerminated: 0,
          lossTerminationReasons: new Map<string, number>(),
          formationDelays: newTiming(),
          lostIntervals: newTiming(),
          peakTargets: 0,
          peakTemporarySamples: 0,
          peakReferences: 0,
          reasons: new Map<string, number>(),
          lostReasons: new Map<string, number>(),
        },
      };
    }),
  );
  let wallMs = 0;
  let cpuMicros = 0;
  return {
    replaceReferences(now: number) {
      for (const variant of variants) variant.domain.replaceReferences(now);
    },
    start(
      input: Parameters<
        ReturnType<typeof createAppearanceIdentity>["start"]
      >[0],
    ) {
      for (const variant of variants) variant.domain.start(input);
    },
    consume(
      observation: Parameters<
        ReturnType<typeof createAppearanceIdentity>["tracking"]
      >[0],
      evidence: Parameters<
        ReturnType<typeof createAppearanceIdentity>["acceptAppearance"]
      >[0],
      identity: Parameters<
        ReturnType<typeof createAppearanceIdentity>["identity"]
      >[0],
      now: number,
    ) {
      const started = performance.now(),
        cpu = process.cpuUsage();
      const direct = new Set(
        identity.tracks
          .filter((track) => track.state === "confirmed")
          .map((track) => track.trackId),
      );
      const active = new Set(observation.tracks.map((track) => track.trackId));
      const fresh = new Set(evidence.evidence.map((item) => item.trackId));
      const records = variants.map((variant) => {
        variant.domain.tracking(observation, now);
        variant.domain.acceptAppearance(evidence);
        variant.domain.identity(identity, now, now);
        const snapshot = variant.domain.snapshot();
        const stats = variant.statistics;
        stats.peakTargets = Math.max(
          stats.peakTargets,
          snapshot.statistics.targetCount,
        );
        stats.peakTemporarySamples = Math.max(
          stats.peakTemporarySamples,
          snapshot.statistics.temporarySamples,
        );
        stats.peakReferences = Math.max(
          stats.peakReferences,
          snapshot.references.length,
        );
        const targets = snapshot.targets.map((target) => {
          const previous = variant.tracks.get(target.trackId) ?? {
            inferred: false,
            candidateAt: null,
            lossAt: null,
          };
          const inferred = target.inferred !== null;
          if (active.has(target.trackId) && !target.ending) {
            stats.observations++;
            if (inferred) stats.inferredObservations++;
            stats.reasons.set(
              target.reason,
              (stats.reasons.get(target.reason) ?? 0) + 1,
            );
          }
          const failAttempt = (reason: string) => {
            if (previous.candidateAt === null) return;
            stats.failedEligibleOnsets++;
            stats.failedReasons.set(
              reason,
              (stats.failedReasons.get(reason) ?? 0) + 1,
            );
            previous.candidateAt = null;
          };
          if (target.blocked) failAttempt(target.reason);
          if (
            previous.candidateAt !== null &&
            now - previous.candidateAt >= variant.policy.supportWindowMs
          )
            failAttempt("support_window_elapsed");
          const eligible =
            !target.blocked &&
            !target.ending &&
            !direct.has(target.trackId) &&
            fresh.has(target.trackId) &&
            target.candidate !== null &&
            target.candidate.score >= variant.policy.threshold &&
            target.candidate.margin >= variant.policy.margin;
          if (eligible && !inferred && previous.candidateAt === null) {
            previous.candidateAt = now;
            stats.eligibleOnsets++;
          }
          if (inferred && !previous.inferred) {
            stats.formations++;
            if (previous.candidateAt !== null) {
              stats.completedEligibleOnsets++;
              addTiming(stats.formationDelays, now - previous.candidateAt);
            } else stats.formationsWithoutEligibleOnset++;
            previous.candidateAt = null;
            if (previous.lossAt !== null) {
              stats.reacquisitions++;
              addTiming(stats.lostIntervals, now - previous.lossAt);
              previous.lossAt = null;
            }
          }
          if (
            !inferred &&
            previous.inferred &&
            !target.ending &&
            !direct.has(target.trackId)
          ) {
            stats.lossWhileActive++;
            stats.lostReasons.set(
              target.reason,
              (stats.lostReasons.get(target.reason) ?? 0) + 1,
            );
            previous.lossAt = now;
          }
          if (
            !inferred &&
            previous.candidateAt !== null &&
            (target.ending ||
              direct.has(target.trackId) ||
              (!eligible && fresh.has(target.trackId)))
          ) {
            failAttempt(
              target.ending
                ? "target_ending"
                : direct.has(target.trackId)
                  ? "direct_confirmation"
                  : target.reason,
            );
          }
          if (
            (direct.has(target.trackId) || target.ending) &&
            previous.lossAt !== null
          ) {
            stats.unrecoveredLossesTerminated++;
            const reason = target.ending
              ? "target_ending"
              : "direct_confirmation";
            stats.lossTerminationReasons.set(
              reason,
              (stats.lossTerminationReasons.get(reason) ?? 0) + 1,
            );
            previous.lossAt = null;
          }
          previous.inferred = inferred;
          variant.tracks.set(target.trackId, previous);
          return {
            trackId: target.trackId,
            inferred,
            reason: target.reason,
            score: target.candidate?.score ?? null,
            margin: target.candidate?.margin ?? null,
            referenceIds: target.inferred?.referenceIds ?? [],
          };
        });
        const retained = new Set(
          snapshot.targets.map((target) => target.trackId),
        );
        for (const [trackId, state] of variant.tracks) {
          if (!retained.has(trackId)) {
            if (state.candidateAt !== null) {
              stats.failedEligibleOnsets++;
              stats.failedReasons.set(
                "target_removed",
                (stats.failedReasons.get("target_removed") ?? 0) + 1,
              );
            }
            if (state.lossAt !== null) {
              stats.unrecoveredLossesTerminated++;
              stats.lossTerminationReasons.set(
                "target_removed",
                (stats.lossTerminationReasons.get("target_removed") ?? 0) + 1,
              );
            }
            variant.tracks.delete(trackId);
          }
        }
        return {
          policyVersion: variant.policy.policyVersion,
          references: snapshot.references.length,
          targets,
        };
      });
      const used = process.cpuUsage(cpu);
      wallMs += performance.now() - started;
      cpuMicros += used.user + used.system;
      return records;
    },
    snapshot() {
      return {
        purpose:
          "isolated public diagnostic policy comparison; never installed in main",
        fixed: {
          threshold: 0.94,
          margin: 0.13,
          inferenceTtlMs: 5000,
          minimumSupportIntervalMs: 500,
          minimumSupports: 2,
        },
        truth:
          "no per-frame identity GT; inferred counts are extra tentative outputs, not correctly attributed coverage",
        definitions: {
          formationDelay:
            "media time from first eligible fresh support to inference onset; attempts end as completed/failed, or remain pending; no historical attempt list is retained",
          activeLoss:
            "inferred-to-unknown while target remains active, excluding upgrade to direct confirmation",
          reacquisition:
            "same active target regains inference after such loss; not a complete online flicker guarantee",
          cachePeak:
            "per-sampled-frame logical domain counts, not an RSS hard bound",
        },
        resources: {
          processingWallMs: wallMs,
          processingCpuMs: cpuMicros / 1000,
          modelCallsAdded: 0,
        },
        variants: variants.map(({ policy, domain, statistics, tracks }) => ({
          policy,
          ...statistics,
          reasons: Object.fromEntries(statistics.reasons),
          failedReasons: Object.fromEntries(statistics.failedReasons),
          formationDelayMeanMs: statistics.formationDelays.count
            ? statistics.formationDelays.totalMs /
              statistics.formationDelays.count
            : null,
          lostIntervalMeanMs: statistics.lostIntervals.count
            ? statistics.lostIntervals.totalMs / statistics.lostIntervals.count
            : null,
          lostReasons: Object.fromEntries(statistics.lostReasons),
          lossTerminationReasons: Object.fromEntries(
            statistics.lossTerminationReasons,
          ),
          pendingLosses: [...tracks.values()].filter(
            (track) => track.lossAt !== null,
          ).length,
          unresolvedEligibleOnsets: [...tracks.values()].filter(
            (track) => track.candidateAt !== null && !track.inferred,
          ).length,
          final: domain.snapshot(),
        })),
      };
    },
  };
}
