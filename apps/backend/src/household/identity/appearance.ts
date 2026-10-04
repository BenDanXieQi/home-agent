import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  identityCapacity,
  identityReferenceVersionsSchema,
  type identityObservationSchema,
  type trackingObservationSchema,
} from "@home-agent/api/contracts";
import type { stateVersionSchema } from "@home-agent/api/household";
import type { appearanceEvidenceSchema } from "./appearance-evidence";
import type { createIdentityMatching } from "./matching";

// Resource limits and time candidates are not calibrated recognition parameters.
export const appearanceLimits = {
  targets: 256,
  temporarySamples: 8192,
  metadataBytesPerSample: 4096,
  eventBytes: 34 * 1024 * 1024,
  referencesPerMember: 5,
  members: identityCapacity.members,
  minimumSupportIntervalMs: 500,
  referenceTtlMs: 600_000,
  supportWindowMs: 5000,
  inferenceTtlMs: 5000,
} as const;
export const appearanceCalibrationSchema = z.strictObject({
  policyVersion: z.string().min(1).max(128),
  threshold: z.number().min(-1).max(1),
  margin: z.number().min(0).max(2),
  referenceTtlMs: z.int().positive().max(appearanceLimits.referenceTtlMs),
  supportWindowMs: z.int().min(500).max(appearanceLimits.supportWindowMs),
  inferenceTtlMs: z.int().positive().max(appearanceLimits.inferenceTtlMs),
});
type Appearance = z.infer<typeof appearanceEvidenceSchema>;
type Observation = z.infer<typeof identityObservationSchema>;
type Face = Observation["tracks"][number]["evidence"][number];
type Versions = z.infer<typeof identityReferenceVersionsSchema>;
function targetKey(
  run: Appearance["run"],
  generation: string,
  trackId: number,
) {
  return JSON.stringify([run.scopeEpoch, run.runId, generation, trackId]);
}
function frameKey(value: Pick<Appearance, "run" | "mediaTime" | "trackId">) {
  return `${value.run.runId}:${value.mediaTime.generation}:${value.mediaTime.rtpTimestamp}:${value.trackId}`;
}
function cacheAppearance(
  evidence: Appearance,
  acceptedAt: number,
  remainingMs: number,
) {
  return {
    evidence: structuredClone(evidence),
    deadline: acceptedAt + remainingMs,
    clock: acceptedAt - evidence.ageMs,
  };
}
function cacheConfirmation(evidence: Face, memberId: string, deadline: number) {
  return {
    evidence: structuredClone(evidence),
    versions: identityReferenceVersionsSchema.parse(evidence.provenance),
    memberId,
    deadline,
  };
}
function newTarget(
  key: string,
  trackId: number,
  source: ReturnType<typeof newSource>,
) {
  return {
    key,
    trackId,
    source,
    appearances: new Map<string, ReturnType<typeof cacheAppearance>>(),
    confirmations: new Map<string, ReturnType<typeof cacheConfirmation>>(),
    faceSequence: source.confirmationCutoff,
    appearanceSequence: 0,
    cutoff: 0,
    blocked: false,
    directMember: null as string | null,
    directConfirmed: false,
    origins: new Map<string, ReturnType<typeof referenceSummary>>(),
    directDeadline: 0,
    endingAt: null as number | null,
    trackingDeadline: 0,
    lastObservedAt: null as number | null,
    supports: [] as {
      evidence: Omit<Appearance, "vector">;
      clock: number;
      deadline: number;
      memberId: string;
      referenceIds: string[];
      score: number;
      margin: number;
    }[],
    inferred: null as {
      memberId: string;
      referenceIds: string[];
      references: ReturnType<typeof referenceSummary>[];
      observedAt: number;
      expiresAt: number;
      deadline: number;
      score: number;
      margin: number;
      policyVersion: string;
      evidence: Omit<Appearance, "vector">[];
    } | null,
    candidate: null as {
      memberId: string;
      score: number;
      margin: number;
    } | null,
    reason: "no_new_feature",
  };
}
function newSource(input: {
  run: Appearance["run"];
  householdVersion: z.infer<typeof stateVersionSchema>;
  sampleFps: number;
  maxFrameAgeMs: number;
  evidenceTtlMs: number;
  recentTtlMs: number;
  modelVersion: string;
  processingVersion: string;
}) {
  return {
    ...input,
    generation: "",
    trackingSequence: 0,
    identityRevision: 0,
    identitySequence: 0,
    confirmationCutoff: 0,
    maximumTrackId: 0,
  };
}
function referenceSummary(reference: ReturnType<typeof newReference>) {
  const { vector: _vector, deadline: _deadline, ...summary } = reference;
  return summary;
}
function newReference(
  sourceTargetKey: string,
  pair: ReturnType<typeof cacheAppearance>,
  confirmation: ReturnType<typeof cacheConfirmation>,
  ttl: number,
) {
  const { vector, ...appearance } = pair.evidence;
  return {
    referenceId: crypto.randomUUID(),
    sourceTargetKey,
    memberId: confirmation.memberId,
    face: confirmation.evidence,
    referenceVersions: confirmation.versions,
    appearance,
    vector,
    observedAt: confirmation.evidence.observedAt,
    expiresAt: confirmation.evidence.observedAt + ttl,
    deadline: pair.clock + ttl,
  };
}
function revocationTrigger(
  observation: Observation,
  track: Observation["tracks"][number],
) {
  // Retain the original state even when an individual evidence payload exceeds
  // the metadata budget. Resource admission must never hide a conflict or end.
  const evidence = track.evidence.filter(
    (face) =>
      Buffer.byteLength(JSON.stringify(face)) <=
      appearanceLimits.metadataBytesPerSample,
  );
  return {
    observation: {
      revision: observation.revision,
      run: observation.run,
      sequence: observation.sequence,
      mediaTime: observation.mediaTime,
    },
    track: { ...track, evidence },
    omittedEvidence: track.evidence.length - evidence.length,
  };
}
function targetSummary(target: ReturnType<typeof newTarget>) {
  return {
    sourceTargetKey: target.key,
    trackId: target.trackId,
    blocked: target.blocked,
    ending: target.endingAt !== null,
    reason: target.reason,
    candidate: target.candidate,
    inferred: target.inferred
      ? (({ deadline: _deadline, ...inferred }) => inferred)(target.inferred)
      : null,
  };
}
function revokedEvent(
  target: ReturnType<typeof newTarget>,
  references: ReturnType<typeof referenceSummary>[],
  reason:
    | "face_conflict"
    | "identity_replaced"
    | "terminal_identity_unavailable",
  trigger: ReturnType<typeof revocationTrigger> | null,
) {
  return {
    kind: "reference_revoked" as const,
    sourceTargetKey: target.key,
    referenceIds: references.map((reference) => reference.referenceId),
    references,
    reason,
    trigger,
  };
}
function invalidatedEvent(
  references: ReturnType<typeof newReference>[],
  reason:
    | "reference_versions_changed"
    | "source_retired"
    | "media_generation_changed"
    | "model_versions_changed",
) {
  return {
    kind: "references_invalidated" as const,
    reason,
    referenceIds: references.map((reference) => reference.referenceId),
    references: references.map(referenceSummary),
  };
}
function endedEvent(
  target: ReturnType<typeof newTarget>,
  trustworthy: boolean,
  observedEndedAt: number | null,
) {
  return {
    kind: "target_ended" as const,
    sourceTargetKey: target.key,
    run: target.source.run,
    trackId: target.trackId,
    lastObservedAt: target.lastObservedAt,
    observedEndedAt,
    trustworthy,
  };
}
type Event =
  | ReturnType<typeof revokedEvent>
  | ReturnType<typeof invalidatedEvent>
  | ReturnType<typeof endedEvent>
  | { kind: "changed" };

/** Single household owner; all clock values belong to the receiving process. */
export function createAppearanceIdentity(options: {
  matching: Pick<
    ReturnType<typeof createIdentityMatching>,
    "snapshot" | "associate"
  >;
  calibration?: z.infer<typeof appearanceCalibrationSchema>;
}) {
  const policy = options.calibration
    ? appearanceCalibrationSchema.parse(options.calibration)
    : null;
  const sources = new Map<string, ReturnType<typeof newSource>>();
  const targets = new Map<string, ReturnType<typeof newTarget>>();
  const references = new Map<string, ReturnType<typeof newReference>>();
  const listeners = new Set<(event: Event) => void>();
  let versions: Versions | null = null;
  let revision = 0;
  const statistics = {
    capacitySkipped: 0,
    referencesCreated: 0,
    referencesRevoked: 0,
    duplicateEvidence: 0,
  };
  function emit(event: Event) {
    if (Buffer.byteLength(JSON.stringify(event)) > appearanceLimits.eventBytes)
      throw new Error(
        "Appearance domain event exceeds its bounded metadata budget",
      );
    for (const listener of listeners) listener(structuredClone(event));
  }
  function changed() {
    revision++;
    emit({ kind: "changed" });
  }
  function removeReferences(removed: ReturnType<typeof newReference>[]) {
    const ids = new Set<string>(
      removed.map((reference) => reference.referenceId),
    );
    for (const id of ids) references.delete(id);
    for (const target of targets.values()) {
      target.supports = target.supports.filter(
        (support) => !support.referenceIds.some((id) => ids.has(id)),
      );
      if (target.inferred?.referenceIds.some((id) => ids.has(id))) {
        target.inferred = null;
        target.reason = "reference_unavailable";
      }
    }
  }
  function revoke(
    target: ReturnType<typeof newTarget>,
    reason: Parameters<typeof revokedEvent>[2],
    trigger: Parameters<typeof revokedEvent>[3],
  ) {
    const removed = [...references.values()].filter(
      (reference) => reference.sourceTargetKey === target.key,
    );
    removeReferences(removed);
    target.supports = [];
    target.inferred = null;
    target.appearances.clear();
    target.confirmations.clear();
    statistics.referencesRevoked += target.origins.size;
    // The event is synchronous, including for an empty reference set: activity owns its own dependencies.
    emit(revokedEvent(target, [...target.origins.values()], reason, trigger));
    target.origins.clear();
  }
  function finish(
    target: ReturnType<typeof newTarget>,
    trustworthy: boolean,
    observedEndedAt: number | null = null,
  ) {
    if (!trustworthy) revoke(target, "terminal_identity_unavailable", null);
    target.supports = [];
    target.inferred = null;
    emit(endedEvent(target, trustworthy, observedEndedAt));
    targets.delete(target.key);
  }
  function prune(now: number) {
    removeReferences(
      [...references.values()].filter((reference) => reference.deadline <= now),
    );
    for (const target of targets.values()) {
      for (const [key, sample] of target.appearances)
        if (sample.deadline <= now) target.appearances.delete(key);
      for (const [key, sample] of target.confirmations)
        if (sample.deadline <= now) target.confirmations.delete(key);
      target.supports = target.supports.filter(
        (support) =>
          support.deadline > now &&
          support.referenceIds.every((id) => references.has(id)),
      );
      if (
        target.inferred &&
        (target.inferred.deadline <= now ||
          target.trackingDeadline <= now ||
          target.endingAt !== null)
      )
        target.inferred = null;
      if (
        target.endingAt !== null &&
        now - target.endingAt >= target.source.recentTtlMs
      )
        finish(target, false);
    }
  }
  function temporaryCount() {
    return [...targets.values()].reduce(
      (total, target) =>
        total +
        target.appearances.size +
        target.confirmations.size +
        target.supports.length +
        target.origins.size,
      0,
    );
  }
  function cacheCapacity(
    target: ReturnType<typeof newTarget>,
    size: number,
    windowMs = target.source.maxFrameAgeMs,
  ) {
    if (
      size >= Math.ceil((target.source.sampleFps * windowMs) / 1000) + 1 ||
      temporaryCount() >= appearanceLimits.temporarySamples
    ) {
      statistics.capacitySkipped++;
      return false;
    }
    return true;
  }
  function pair(
    target: ReturnType<typeof newTarget>,
    key: string,
    now: number,
  ) {
    const appearance = target.appearances.get(key);
    const face = target.confirmations.get(key);
    if (!appearance || !face) return;
    target.appearances.delete(key);
    target.confirmations.delete(key);
    if (
      target.blocked ||
      target.endingAt !== null ||
      face.evidence.provenance.sequence <= target.cutoff ||
      appearance.deadline <= now ||
      face.deadline <= now ||
      appearance.evidence.sequence !== face.evidence.provenance.sequence ||
      appearance.evidence.receivedAt !== face.evidence.observedAt ||
      !isDeepStrictEqual(face.versions, versions)
    )
      return;
    if (temporaryCount() >= appearanceLimits.temporarySamples) {
      statistics.capacitySkipped++;
      return;
    }
    const memberReferences = [...references.values()].filter(
      (reference) => reference.memberId === face.memberId,
    );
    if (memberReferences.length >= appearanceLimits.referencesPerMember) {
      // Keep at least one sample from each established source; quality breaks same-source ties.
      const sourceKey = (reference: ReturnType<typeof newReference>) =>
        `${reference.appearance.run.deviceId}:${reference.appearance.run.channel}`;
      const incomingKey = `${appearance.evidence.run.deviceId}:${appearance.evidence.run.channel}`;
      const same = memberReferences.filter(
        (reference) => sourceKey(reference) === incomingKey,
      );
      const pool = same.length
        ? same
        : memberReferences.filter(
            (reference) =>
              memberReferences.filter(
                (other) => sourceKey(other) === sourceKey(reference),
              ).length > 1,
          );
      const victim = pool.toSorted(
        (a, b) =>
          a.face.sharpness - b.face.sharpness || a.observedAt - b.observedAt,
      )[0];
      if (!victim) {
        statistics.capacitySkipped++;
        return;
      }
      if (same.length && face.evidence.sharpness < victim.face.sharpness)
        return;
      removeReferences([victim]);
    }
    if (
      !memberReferences.length &&
      new Set([...references.values()].map((reference) => reference.memberId))
        .size >= appearanceLimits.members
    ) {
      statistics.capacitySkipped++;
      return;
    }
    const reference = newReference(
      target.key,
      appearance,
      face,
      policy?.referenceTtlMs ?? appearanceLimits.referenceTtlMs,
    );
    if (reference.deadline <= now) return;
    if (
      Buffer.byteLength(JSON.stringify(referenceSummary(reference))) >
      appearanceLimits.metadataBytesPerSample
    ) {
      statistics.capacitySkipped++;
      return;
    }
    references.set(reference.referenceId, reference);
    target.origins.set(reference.referenceId, referenceSummary(reference));
    statistics.referencesCreated++;
  }
  function rank(
    target: ReturnType<typeof newTarget>,
    evidence: Appearance,
    clock: number,
    now: number,
  ) {
    const { vector, ...summary } = evidence;
    target.candidate = null;
    if (target.blocked) {
      target.reason = "face_conflict";
      return;
    }
    if (target.directConfirmed && target.directDeadline > now) {
      target.supports = [];
      target.inferred = null;
      target.reason = "direct_identity_confirmed";
      return;
    }
    const ranked = new Map<
      string,
      {
        memberId: string;
        score: number;
        referenceIds: string[];
        scores: Map<string, number>;
      }
    >();
    for (const reference of references.values()) {
      if (
        reference.deadline <= now ||
        reference.appearance.modelVersion !== evidence.modelVersion ||
        reference.appearance.processingVersion !== evidence.processingVersion
      )
        continue;
      const score = Math.max(
        -1,
        Math.min(
          1,
          vector.reduce(
            (total, value, index) => total + value * reference.vector[index]!,
            0,
          ),
        ),
      );
      const current = ranked.get(reference.memberId);
      if (current) {
        current.score = Math.max(current.score, score);
        current.scores.set(reference.referenceId, score);
      } else
        ranked.set(reference.memberId, {
          memberId: reference.memberId,
          score,
          referenceIds: [],
          scores: new Map([[reference.referenceId, score]]),
        });
    }
    const [best, second] = [...ranked.values()].toSorted(
      (a, b) => b.score - a.score,
    );
    target.inferred = null;
    if (!best) {
      target.supports = [];
      target.reason = references.size
        ? "feature_version_mismatch"
        : "no_reference";
      return;
    }
    const margin = best.score - (second?.score ?? -1);
    target.candidate = { memberId: best.memberId, score: best.score, margin };
    if (!policy) {
      target.supports = [];
      target.reason = "uncalibrated_policy";
      return;
    }
    if (
      best.score < policy.threshold ||
      margin < policy.margin ||
      (second && margin === 0)
    ) {
      target.supports = [];
      target.reason =
        best.score < policy.threshold
          ? "score_insufficient"
          : "candidates_close";
      return;
    }
    if (
      target.directMember &&
      target.directDeadline > now &&
      target.directMember !== best.memberId
    ) {
      target.supports = [];
      target.reason = "direct_identity_disagreement";
      return;
    }
    best.referenceIds = [...best.scores]
      .filter(
        ([, score]) =>
          score >= policy.threshold &&
          score - (second?.score ?? -1) >= policy.margin,
      )
      .map(([id]) => id);
    target.supports = target.supports.filter(
      (support) =>
        support.memberId === best.memberId &&
        support.clock + policy.supportWindowMs > now &&
        support.referenceIds.some((id) => best.referenceIds.includes(id)),
    );
    if (!cacheCapacity(target, target.supports.length, policy.supportWindowMs))
      return;
    target.supports.push({
      evidence: summary,
      clock,
      deadline: clock + policy.supportWindowMs,
      memberId: best.memberId,
      referenceIds: best.referenceIds,
      score: best.score,
      margin,
    });
    // All supporting frames must share a reference still eligible right now.
    const common = best.referenceIds.filter((id) =>
      target.supports.every((support) => support.referenceIds.includes(id)),
    );
    const first = target.supports[0];
    const deadline = Math.min(
      clock + policy.inferenceTtlMs,
      ...common.map((id) => references.get(id)!.deadline),
    );
    if (
      !first ||
      target.supports.length < 2 ||
      clock - first.clock < appearanceLimits.minimumSupportIntervalMs ||
      evidence.receivedAt - first.evidence.receivedAt <
        appearanceLimits.minimumSupportIntervalMs ||
      !common.length ||
      Math.min(deadline, target.trackingDeadline) <= now
    ) {
      target.reason = "insufficient_support";
      return;
    }
    target.inferred = {
      memberId: best.memberId,
      referenceIds: common,
      references: common.map((id) => referenceSummary(references.get(id)!)),
      observedAt: evidence.receivedAt,
      expiresAt:
        evidence.receivedAt +
        Math.min(deadline, target.trackingDeadline) -
        clock,
      deadline,
      score: best.score,
      margin,
      policyVersion: policy.policyVersion,
      evidence: target.supports.map((support) => support.evidence),
    };
    target.reason = "appearance_support";
  }
  function changeGeneration(
    source: ReturnType<typeof newSource>,
    generation: string,
  ) {
    if (source.generation === generation) return;
    for (const target of targets.values())
      if (target.source === source) finish(target, false);
    const removed = [...references.values()].filter(
      (reference) => reference.appearance.run.runId === source.run.runId,
    );
    removeReferences(removed);
    emit(invalidatedEvent(removed, "media_generation_changed"));
    source.generation = generation;
    source.maximumTrackId = 0;
  }
  return {
    start(input: Parameters<typeof newSource>[0]) {
      if (input.householdVersion.scope_epoch !== input.run.scopeEpoch) return;
      if (
        Buffer.byteLength(JSON.stringify(input)) >
        appearanceLimits.metadataBytesPerSample
      ) {
        statistics.capacitySkipped++;
        return;
      }
      if (sources.size >= 8 && !sources.has(input.run.runId)) {
        statistics.capacitySkipped++;
        return;
      }
      const incompatible = [...references.values()].filter(
        (reference) =>
          reference.appearance.modelVersion !== input.modelVersion ||
          reference.appearance.processingVersion !== input.processingVersion,
      );
      if (incompatible.length) {
        removeReferences(incompatible);
        emit(invalidatedEvent(incompatible, "model_versions_changed"));
      }
      sources.set(input.run.runId, newSource(input));
    },
    replaceReferences(now: number) {
      prune(now);
      const snapshot = options.matching.snapshot();
      const next = snapshot
        ? identityReferenceVersionsSchema.parse(snapshot)
        : null;
      if (isDeepStrictEqual(next, versions)) return;
      const removed = [...references.values()];
      removeReferences(removed);
      versions = next;
      for (const source of sources.values())
        source.confirmationCutoff = Math.max(
          source.confirmationCutoff,
          source.identitySequence,
          source.trackingSequence,
        );
      for (const target of targets.values()) {
        // A restored snapshot admits only frames produced after this boundary,
        // including when null is followed by the same reference version.
        target.faceSequence = Math.max(
          target.faceSequence,
          target.source.confirmationCutoff,
        );
        target.appearances.clear();
        target.confirmations.clear();
        target.supports = [];
        target.inferred = null;
        target.directMember = null;
        target.directConfirmed = false;
        target.directDeadline = 0;
        target.candidate = null;
      }
      emit(invalidatedEvent(removed, "reference_versions_changed"));
      changed();
    },
    media(run: Appearance["run"], generation: string) {
      const source = sources.get(run.runId);
      if (
        !source ||
        !isDeepStrictEqual(source.run, run) ||
        Buffer.byteLength(generation) > 512
      )
        return;
      changeGeneration(source, generation);
      changed();
    },
    tracking(
      observation: z.infer<typeof trackingObservationSchema>,
      acceptedAt: number,
    ) {
      prune(acceptedAt);
      const source = sources.get(observation.run.runId);
      if (
        !source ||
        !isDeepStrictEqual(source.run, observation.run) ||
        Buffer.byteLength(observation.mediaTime.generation) > 512 ||
        observation.sequence <= source.trackingSequence
      )
        return;
      source.trackingSequence = observation.sequence;
      changeGeneration(source, observation.mediaTime.generation);
      const active = new Set(
        observation.tracks
          .filter((track) => track.className === "human")
          .map((track) => track.trackId),
      );
      for (const target of targets.values())
        if (
          target.source === source &&
          !active.has(target.trackId) &&
          target.endingAt === null
        ) {
          target.endingAt = acceptedAt;
          target.inferred = null;
          target.supports = [];
          target.appearances.clear();
          target.confirmations.clear();
        }
      const previousMaximum = source.maximumTrackId;
      for (const track of observation.tracks) {
        source.maximumTrackId = Math.max(source.maximumTrackId, track.trackId);
        if (track.className !== "human") continue;
        const key = targetKey(source.run, source.generation, track.trackId);
        let target = targets.get(key);
        if (!target && track.trackId > previousMaximum) {
          if (targets.size >= appearanceLimits.targets) {
            statistics.capacitySkipped++;
            continue;
          }
          target = newTarget(key, track.trackId, source);
          targets.set(key, target);
        }
        if (!target || target.endingAt !== null) continue;
        target.lastObservedAt = observation.receivedAt;
        const frameClock = acceptedAt - observation.ageMs;
        const measuredAge = observation.receivedAt - track.lastMeasuredAt;
        target.trackingDeadline =
          measuredAge < 0
            ? frameClock
            : Math.min(
                frameClock + source.maxFrameAgeMs,
                frameClock + 2000 - measuredAge,
              );
        if (target.inferred) {
          if (target.trackingDeadline <= acceptedAt) target.inferred = null;
          else
            target.inferred.expiresAt =
              observation.receivedAt +
              Math.min(target.inferred.deadline, target.trackingDeadline) -
              frameClock;
        }
        if (track.feature !== "extracted" && !target.blocked)
          target.reason = "no_new_feature";
      }
      changed();
    },
    acceptAppearance(input: {
      evidence: Appearance[];
      householdVersion: z.infer<typeof stateVersionSchema>;
      acceptedAt: number;
      remainingMs: number;
    }) {
      prune(input.acceptedAt);
      for (const evidence of input.evidence) {
        const source = sources.get(evidence.run.runId);
        if (
          !source ||
          source.householdVersion.scope_epoch !==
            input.householdVersion.scope_epoch ||
          !isDeepStrictEqual(source.run, evidence.run) ||
          source.generation !== evidence.mediaTime.generation ||
          evidence.sequence !== source.trackingSequence ||
          evidence.modelVersion !== source.modelVersion ||
          evidence.processingVersion !== source.processingVersion ||
          input.remainingMs <= 0 ||
          input.remainingMs > source.maxFrameAgeMs
        )
          continue;
        const target = targets.get(
          targetKey(evidence.run, source.generation, evidence.trackId),
        );
        if (!target || target.endingAt !== null) continue;
        if (evidence.sequence <= target.appearanceSequence) {
          statistics.duplicateEvidence++;
          continue;
        }
        target.appearanceSequence = evidence.sequence;
        // Keep new frames while blocked so a later same-frame legal confirmation
        // can pair them. pair/rank still prohibit references and inference here.
        const key = frameKey(evidence);
        if (
          target.appearances.has(key) ||
          target.supports.some(
            (support) => frameKey(support.evidence) === key,
          ) ||
          [...target.origins.values()].some(
            (reference) => reference.face.provenance.evidenceKey === key,
          )
        ) {
          statistics.duplicateEvidence++;
          continue;
        }
        const { vector: _vector, ...metadata } = evidence;
        if (
          Buffer.byteLength(JSON.stringify(metadata)) >
          appearanceLimits.metadataBytesPerSample
        ) {
          statistics.capacitySkipped++;
          continue;
        }
        const clock = input.acceptedAt - evidence.ageMs;
        if (cacheCapacity(target, target.appearances.size))
          target.appearances.set(
            key,
            cacheAppearance(evidence, input.acceptedAt, input.remainingMs),
          );
        pair(target, key, input.acceptedAt);
        rank(target, evidence, clock, input.acceptedAt);
      }
      changed();
    },
    identity(observation: Observation, acceptedAt: number, wallNow: number) {
      prune(acceptedAt);
      const source = sources.get(observation.run.runId);
      if (
        !source ||
        !isDeepStrictEqual(source.run, observation.run) ||
        source.generation !== observation.mediaTime.generation ||
        observation.revision <= source.identityRevision ||
        observation.sequence < source.identitySequence
      )
        return;
      source.identityRevision = observation.revision;
      source.identitySequence = observation.sequence;
      const compatible =
        versions !== null &&
        isDeepStrictEqual(observation.referenceVersions, versions);
      const all = [...observation.tracks, ...observation.recent];
      const validFaces = (track: Observation["tracks"][number]) =>
        track.evidence.filter((face) => {
          const p = face.provenance;
          return (
            p.sourceRunId === source.run.runId &&
            p.mediaGeneration === source.generation &&
            p.trackId === track.trackId &&
            p.sequence <= observation.sequence &&
            p.evidenceKey ===
              `${p.sourceRunId}:${p.mediaGeneration}:${p.rtpTimestamp}:${p.trackId}` &&
            isDeepStrictEqual(
              identityReferenceVersionsSchema.parse(p),
              versions,
            ) &&
            face.observedAt <= observation.receivedAt &&
            face.observedAt <= wallNow
          );
        });
      const legal = new Map(
        options.matching
          .associate(
            { ...observation, tracks: all },
            source.evidenceTtlMs,
            wallNow,
          )
          .filter((association) => association.className === "human")
          .map((association) => [association.trackId, association]),
      );
      // Destructive updates from BOTH collections precede every positive update.
      for (const track of all) {
        const target = targets.get(
          targetKey(source.run, source.generation, track.trackId),
        );
        if (!target) continue;
        const faces = compatible ? validFaces(track) : [];
        const latestSequence = Math.max(
          track.state === "conflict" && !faces.length && !target.blocked
            ? observation.sequence
            : 0,
          ...faces.map((face) => face.provenance.sequence),
        );
        const confirmed = legal.get(track.trackId);
        const replacement =
          confirmed?.state === "confirmed" &&
          latestSequence > target.faceSequence &&
          [...target.origins.values()].some(
            (reference) => reference.memberId !== confirmed.memberId,
          );
        if (
          (track.state === "conflict" && latestSequence > target.cutoff) ||
          replacement
        ) {
          target.cutoff = Math.max(target.cutoff, latestSequence);
          target.blocked = true;
          target.directMember = null;
          target.directConfirmed = false;
          target.directDeadline = 0;
          target.reason =
            track.state === "conflict" ? "face_conflict" : "identity_replaced";
          revoke(
            target,
            track.state === "conflict" ? "face_conflict" : "identity_replaced",
            revocationTrigger(observation, track),
          );
        }
      }
      for (const track of all) {
        const target = targets.get(
          targetKey(source.run, source.generation, track.trackId),
        );
        if (!target) continue;
        const faces = compatible ? validFaces(track) : [];
        const previousSequence = target.faceSequence;
        target.faceSequence = Math.max(
          target.faceSequence,
          ...faces.map((face) => face.provenance.sequence),
        );
        const association = legal.get(track.trackId);
        if (
          association &&
          association.state === "candidate" &&
          !target.blocked
        ) {
          target.directMember = association.memberId;
          target.directConfirmed = false;
          target.directDeadline =
            acceptedAt + Math.max(0, association.expiresAt - wallNow);
          if (target.inferred?.memberId !== association.memberId) {
            target.supports = [];
            target.inferred = null;
          }
        }
        if (
          !compatible ||
          !association ||
          association.state !== "confirmed" ||
          target.endingAt !== null ||
          observation.recent.some((recent) => recent.trackId === track.trackId)
        )
          continue;
        const fresh = faces.filter(
          (face) =>
            face.provenance.sequence > previousSequence &&
            face.provenance.sequence > target.cutoff &&
            face.label === association.memberId,
        );
        if (!fresh.length) continue;
        target.blocked = false;
        target.directMember = association.memberId;
        target.directConfirmed = true;
        target.directDeadline =
          acceptedAt + Math.max(0, association.expiresAt - wallNow);
        target.supports = [];
        target.inferred = null;
        // Only this publication's latest new support is paired; older confirmation history is not replayed.
        const face = fresh.at(-1)!;
        const age =
          observation.ageMs + observation.receivedAt - face.observedAt;
        const key = face.provenance.evidenceKey;
        if (
          age >= source.maxFrameAgeMs ||
          Buffer.byteLength(JSON.stringify(face)) >
            appearanceLimits.metadataBytesPerSample ||
          !cacheCapacity(target, target.confirmations.size)
        )
          continue;
        target.confirmations.set(
          key,
          cacheConfirmation(
            face,
            association.memberId,
            acceptedAt + source.maxFrameAgeMs - age,
          ),
        );
        pair(target, key, acceptedAt);
      }
      for (const track of observation.recent) {
        const target = targets.get(
          targetKey(source.run, source.generation, track.trackId),
        );
        if (!target) continue;
        // A terminal snapshot under an unavailable reference or identity engine cannot certify a clean end.
        finish(
          target,
          compatible &&
            observation.status !== "unavailable" &&
            track.endedAt >= track.lastSeenAt &&
            track.endedAt <= observation.receivedAt &&
            track.endedAt <= wallNow &&
            validFaces(track).length === track.evidence.length,
          track.endedAt,
        );
      }
      changed();
    },
    tick(now: number) {
      prune(now);
      changed();
    },
    stop(runId: string) {
      const source = sources.get(runId);
      if (!source) return;
      for (const target of targets.values())
        if (target.source === source) finish(target, false);
      const removed = [...references.values()].filter(
        (reference) => reference.appearance.run.runId === runId,
      );
      removeReferences(removed);
      emit(invalidatedEvent(removed, "source_retired"));
      sources.delete(runId);
      changed();
    },
    target(sourceTargetKey: string) {
      const target = targets.get(sourceTargetKey);
      return target ? structuredClone(targetSummary(target)) : null;
    },
    snapshot() {
      return structuredClone({
        revision,
        calibrated: policy !== null,
        policyVersion: policy?.policyVersion ?? null,
        statistics: {
          ...statistics,
          temporarySamples: temporaryCount(),
          targetCount: targets.size,
        },
        references: [...references.values()].map(referenceSummary),
        targets: [...targets.values()].map(targetSummary),
      });
    },
    subscribe(listener: (event: Event) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
