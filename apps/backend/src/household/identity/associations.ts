import {
  memberAssociationSchema,
  type perceptionSnapshotSchema,
} from "@home-agent/api/contracts";
import type { z } from "zod";
import type { createIdentityMatching } from "./matching";
import type { createAppearanceIdentity } from "./appearance";

type Source = Pick<
  z.infer<typeof perceptionSnapshotSchema>["sources"][number],
  "run" | "tracking" | "media" | "trackingValidity" | "identityValidity"
> & {
  identity:
    | Parameters<ReturnType<typeof createIdentityMatching>["associate"]>[0]
    | null;
};
/** Owns the selected source results. Updates consume accepted domain state; reads never confirm. */
export function createMemberAssociations(
  matching:
    | Pick<
        ReturnType<typeof createIdentityMatching>,
        "associate" | "member" | "petCandidates"
      >
    | undefined,
  appearance: ReturnType<typeof createAppearanceIdentity> | undefined,
) {
  let selected = new Map<string, z.infer<typeof memberAssociationSchema>[]>();
  return {
    update(sources: Source[], evidenceTtlMs: number | undefined, now: number) {
      const next = new Map<string, z.infer<typeof memberAssociationSchema>[]>();
      for (const source of sources) {
        const run = source.run;
        if (
          !run ||
          source.trackingValidity !== "valid" ||
          !source.tracking ||
          source.tracking.mediaTime.generation !== source.media?.generation
        )
          continue;
        const tracking = source.tracking;
        const generation = tracking.mediaTime.generation;
        const direct =
          source.identity &&
          source.identityValidity === "valid" &&
          evidenceTtlMs !== undefined
            ? (matching?.associate(source.identity, evidenceTtlMs, now) ?? [])
            : [];
        const associations = tracking.tracks.flatMap((track) => {
          const directAssociation = direct.find(
            (item) =>
              item.trackId === track.trackId &&
              (item.className === "human") === (track.className === "human"),
          );
          // Pet features can correct detection species, including tentative matches.
          if (
            directAssociation &&
            (directAssociation.state === "confirmed" ||
              directAssociation.basis === "pet")
          )
            return [memberAssociationSchema.parse(directAssociation)];
          if (
            track.className !== "human" &&
            track.state === "measured" &&
            track.measuredBox
          ) {
            const pet = matching?.petCandidates(track.className);
            if (pet?.members.length === 1)
              return [
                memberAssociationSchema.parse({
                  run,
                  sourceRunId: run.runId,
                  mediaGeneration: generation,
                  trackId: track.trackId,
                  memberId: pet.members[0]!.memberId,
                  memberName: pet.members[0]!.name,
                  memberKind: "pet",
                  className: track.className,
                  basis: "species",
                  state: "inferred",
                  observedAt: tracking.sampledAt,
                  expiresAt: tracking.sampledAt + (evidenceTtlMs ?? 30_000),
                  evidence: [
                    {
                      ...tracking,
                      trackId: track.trackId,
                      measuredBox: track.measuredBox,
                    },
                  ],
                }),
              ];
          }
          if (directAssociation)
            return [memberAssociationSchema.parse(directAssociation)];
          const target = appearance?.target(
            JSON.stringify([
              run.scopeEpoch,
              run.runId,
              generation,
              track.trackId,
            ]),
          );
          const inferred = target?.inferred;
          const member = inferred && matching?.member(inferred.memberId);
          if (
            inferred &&
            member?.className === "human" &&
            !target.blocked &&
            !target.ending &&
            inferred.expiresAt > now &&
            track.className === "human"
          )
            return [
              memberAssociationSchema.parse({
                ...inferred,
                run,
                sourceRunId: run.runId,
                mediaGeneration: generation,
                trackId: track.trackId,
                memberName: member.name,
                memberKind: "person",
                className: "human",
                state: "inferred",
                basis: "appearance",
              }),
            ];
          return [];
        });
        next.set(run.runId, associations);
      }
      selected = next;
    },
    source(runId: string | undefined, now: number) {
      return structuredClone(
        (runId ? selected.get(runId) : undefined)?.filter(
          (item) => item.expiresAt > now,
        ) ?? [],
      );
    },
  };
}
