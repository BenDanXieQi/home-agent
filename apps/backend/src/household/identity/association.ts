import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import {
  identityReferenceVersionsSchema,
  type identityReferenceSnapshotSchema,
  type identityObservationSchema,
} from "@home-agent/api/contracts";

// Project live, accepted evidence without maintaining another confirmation state.
export function associateMembers(
  reference: z.infer<typeof identityReferenceSnapshotSchema> | null,
  names: ReadonlyMap<string, string>,
  observation: z.infer<typeof identityObservationSchema>,
  evidenceTtlMs: number,
  now: number,
) {
  if (!reference) return [];
  const referenceVersions = identityReferenceVersionsSchema.parse(reference);
  if (!isDeepStrictEqual(observation.referenceVersions, referenceVersions))
    return [];
  const members = new Map(
    reference.members
      .filter((member) => member.enabled)
      .map((member) => [member.memberId, member]),
  );
  function hasCurrentProvenance(
    evidence: z.infer<
      typeof identityObservationSchema
    >["tracks"][number]["evidence"][number],
    trackId: number,
  ) {
    const provenance = evidence.provenance;
    return (
      isDeepStrictEqual(
        identityReferenceVersionsSchema.parse(provenance),
        referenceVersions,
      ) &&
      provenance.sourceRunId === observation.run.runId &&
      provenance.trackId === trackId &&
      provenance.mediaGeneration === observation.mediaTime.generation &&
      provenance.sequence <= observation.sequence &&
      provenance.evidenceKey ===
        `${provenance.sourceRunId}:${provenance.mediaGeneration}:${provenance.rtpTimestamp}:${provenance.trackId}`
    );
  }
  return observation.tracks.flatMap((track) => {
    // Pet inference follows the strongest still-valid sample in this track.
    // A weaker new view must not replace a better identity observation.
    const petEvidence = track.evidence.filter((evidence) => {
      const candidate = evidence.bestMemberId
        ? members.get(evidence.bestMemberId)
        : undefined;
      return (
        candidate &&
        candidate.className !== "human" &&
        evidence.score !== null &&
        evidence.observedAt <= now &&
        evidence.observedAt + evidenceTtlMs > now
      );
    });
    const rankedEvidence =
      petEvidence.toSorted(
        (a, b) =>
          (b.score ?? -Infinity) - (a.score ?? -Infinity) ||
          b.observedAt - a.observedAt,
      )[0] ?? track.evidence.at(-1);
    const rankedMember = rankedEvidence?.bestMemberId
      ? members.get(rankedEvidence.bestMemberId)
      : undefined;
    const rankedName = rankedMember && names.get(rankedMember.memberId);
    const ranked =
      rankedEvidence &&
      rankedMember &&
      rankedName !== undefined &&
      rankedEvidence.score !== null &&
      rankedEvidence.observedAt <= now &&
      rankedEvidence.observedAt + evidenceTtlMs > now
        ? {
            member: rankedMember,
            memberName: rankedName,
            evidence: [rankedEvidence],
            state: "inferred" as const,
            observedAt: rankedEvidence.observedAt,
            expiresAt: rankedEvidence.observedAt + evidenceTtlMs,
          }
        : null;
    if (
      rankedEvidence &&
      ranked &&
      !hasCurrentProvenance(rankedEvidence, track.trackId)
    )
      return [];
    const member = track.label ? members.get(track.label) : undefined;
    const memberName = member && names.get(member.memberId);
    const supporting =
      !ranked ||
      (track.state === "confirmed" && track.label === ranked.member.memberId)
        ? track.evidence.filter(
            (evidence) => evidence.label === member?.memberId,
          )
        : [];
    const keys = new Set<string>();
    let previousSequence = 0;
    // Analysis owns pruning and confirmation. An older support expiring
    // between publications must not revoke a still-live latest support.
    const latestSupport = supporting.at(-1);
    const supported =
      member &&
      memberName !== undefined &&
      (track.state === "candidate" || track.state === "confirmed") &&
      track.expiresAt !== null &&
      track.expiresAt > now &&
      latestSupport &&
      supporting.length === track.supportingSamples &&
      track.expiresAt === latestSupport.observedAt + evidenceTtlMs &&
      supporting.every((evidence) => {
        const provenance = evidence.provenance;
        if (
          !hasCurrentProvenance(evidence, track.trackId) ||
          provenance.sequence <= previousSequence ||
          keys.has(provenance.evidenceKey) ||
          evidence.observedAt > now ||
          evidence.bestMemberId !== member.memberId ||
          evidence.score === null ||
          evidence.score < member.threshold ||
          evidence.margin === null ||
          evidence.margin <= member.margin
        )
          return false;
        keys.add(provenance.evidenceKey);
        previousSequence = provenance.sequence;
        return true;
      })
        ? {
            member,
            memberName,
            evidence: supporting,
            state: track.state,
            observedAt: latestSupport.observedAt,
            expiresAt: track.expiresAt,
          }
        : null;
    const selected = supported ?? ranked;
    if (!selected) return [];
    return [
      {
        run: observation.run,
        mediaGeneration: observation.mediaTime.generation,
        referenceVersions,
        evidence: selected.evidence,
        sourceRunId: observation.run.runId,
        trackId: track.trackId,
        memberId: selected.member.memberId,
        memberName: selected.memberName,
        ...(selected.member.className === "human"
          ? {
              basis: "face" as const,
              memberKind: "person" as const,
              className: "human" as const,
            }
          : {
              basis: "pet" as const,
              memberKind: "pet" as const,
              className: selected.member.className,
            }),
        state: selected.state,
        observedAt: selected.observedAt,
        expiresAt: selected.expiresAt,
      },
    ];
  });
}
