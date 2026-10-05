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
    | Pick<ReturnType<typeof createIdentityMatching>, "associate" | "member">
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
        const generation = source.tracking.mediaTime.generation;
        const direct =
          source.identity &&
          source.identityValidity === "valid" &&
          evidenceTtlMs !== undefined
            ? (matching?.associate(source.identity, evidenceTtlMs, now) ?? [])
            : [];
        const associations = source.tracking.tracks.flatMap((track) => {
          const confirmed = direct.find(
            (item) =>
              item.trackId === track.trackId &&
              item.className === track.className,
          );
          if (confirmed?.state === "confirmed")
            return [memberAssociationSchema.parse(confirmed)];
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
          return confirmed ? [memberAssociationSchema.parse(confirmed)] : [];
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
