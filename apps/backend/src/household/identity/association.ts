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
  return observation.tracks.flatMap((track) => {
    if (
      (track.state !== "candidate" && track.state !== "confirmed") ||
      !track.label ||
      !track.expiresAt ||
      track.expiresAt <= now
    )
      return [];
    const member = members.get(track.label);
    const memberName = member && names.get(member.memberId);
    if (!member || memberName === undefined) return [];
    const supporting = track.evidence.filter(
      (evidence) => evidence.label === member.memberId,
    );
    const keys = new Set<string>();
    let previousSequence = 0;
    for (const evidence of supporting) {
      const provenance = evidence.provenance;
      if (
        !isDeepStrictEqual(
          identityReferenceVersionsSchema.parse(provenance),
          referenceVersions,
        ) ||
        provenance.sourceRunId !== observation.run.runId ||
        provenance.trackId !== track.trackId ||
        provenance.mediaGeneration !== observation.mediaTime.generation ||
        provenance.sequence > observation.sequence ||
        provenance.sequence <= previousSequence ||
        provenance.evidenceKey !==
          `${provenance.sourceRunId}:${provenance.mediaGeneration}:${provenance.rtpTimestamp}:${provenance.trackId}` ||
        keys.has(provenance.evidenceKey) ||
        evidence.observedAt > now ||
        evidence.bestMemberId !== member.memberId ||
        evidence.score === null ||
        evidence.score < member.threshold ||
        evidence.margin === null ||
        evidence.margin <= member.margin
      )
        return [];
      keys.add(provenance.evidenceKey);
      previousSequence = provenance.sequence;
    }
    // Analysis owns pruning and confirmation. An older support expiring
    // between publications must not revoke a still-live latest support.
    const latest = supporting.at(-1);
    if (
      !latest ||
      supporting.length !== track.supportingSamples ||
      track.expiresAt !== latest.observedAt + evidenceTtlMs
    )
      return [];
    return [
      {
        run: observation.run,
        mediaGeneration: observation.mediaTime.generation,
        referenceVersions,
        evidence: supporting,
        sourceRunId: observation.run.runId,
        trackId: track.trackId,
        memberId: member.memberId,
        memberName,
        ...(member.className === "human"
          ? {
              basis: "face" as const,
              memberKind: "person" as const,
              className: "human" as const,
            }
          : {
              basis: "pet" as const,
              memberKind: "pet" as const,
              className: member.className,
            }),
        state: track.state,
        observedAt: latest.observedAt,
        expiresAt: track.expiresAt,
      },
    ];
  });
}
