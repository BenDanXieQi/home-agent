import { and, eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { memberActivityDataSchema } from "@home-agent/api/contracts";
import type { Database } from "../../db";
import { contextEntities, contextRecords } from "../../db/schema";
import { createHouseholdBindingAccess } from "../binding-repository";
import { lockIdentityMembers } from "./repository";
import type { memberActivity } from "./activity";

export function createMemberActivityRepository(db: Database) {
  const access = createHouseholdBindingAccess(db);
  return {
    async save(
      identity: Parameters<typeof access>[0],
      assertCurrent: () => void,
      activity: ReturnType<typeof memberActivity>,
    ) {
      // Validate the shared JSON boundary before acquiring storage resources.
      const data = memberActivityDataSchema.parse(activity.record.data);
      const current = data.attribution.current;
      if (
        data.sourceRunId !== data.run.runId ||
        activity.record.scopeEpoch !== data.run.scopeEpoch ||
        data.deviceId !== data.run.deviceId ||
        data.channel !== data.run.channel
      )
        throw new Error("Member activity source identity mismatch");
      if (current.kind === "known") {
        const association = current.association;
        if (
          !isDeepStrictEqual(association.run, data.run) ||
          association.sourceRunId !== data.run.runId ||
          association.mediaGeneration !== data.mediaGeneration ||
          association.trackId !== data.trackId
        )
          throw new Error("Member activity target identity mismatch");
      } else {
        const correction = data.attribution.lastCorrection;
        if (
          !correction ||
          correction.reason !== current.reason ||
          !isDeepStrictEqual(correction.after, current) ||
          correction.before.kind !== "known" ||
          correction.before.association.basis !== "appearance" ||
          !current.trigger.referenceIds.some(
            (id) =>
              correction.before.kind === "known" &&
              correction.before.association.basis === "appearance" &&
              correction.before.association.referenceIds.includes(id),
          )
        )
          throw new Error("Member activity revocation lacks domain evidence");
        if (current.reason === "target_face_conflict") {
          const trigger = current.trigger;
          if (
            trigger.reason !== "target_face_conflict" ||
            trigger.sourceTargetKey !==
              JSON.stringify([
                data.run.scopeEpoch,
                data.run.runId,
                data.mediaGeneration,
                data.trackId,
              ]) ||
            !trigger.trigger ||
            !isDeepStrictEqual(trigger.trigger.observation.run, data.run) ||
            trigger.trigger.observation.mediaTime.generation !==
              data.mediaGeneration ||
            trigger.trigger.track.trackId !== data.trackId ||
            trigger.trigger.track.state !== "conflict"
          )
            throw new Error(
              "Member activity conflict target identity mismatch",
            );
        } else if (current.trigger.reason === "target_face_conflict")
          throw new Error(
            "Member activity reference revocation reason mismatch",
          );
      }
      return access(identity, assertCurrent, async (tx) => {
        await lockIdentityMembers(tx);
        const [saved] = await tx
          .select()
          .from(contextRecords)
          .where(eq(contextRecords.id, activity.record.id))
          .for("update");
        const previous = saved && memberActivityDataSchema.parse(saved.data);
        if (saved && previous) {
          const immutable = (value: typeof data) => ({
            run: value.run,
            mediaGeneration: value.mediaGeneration,
            trackId: value.trackId,
            deviceId: value.deviceId,
            channel: value.channel,
            firstObservedAt: value.firstObservedAt,
            original: value.attribution.original,
          });
          if (
            saved.topic !== activity.record.topic ||
            saved.kind !== activity.record.kind ||
            saved.scopeEpoch !== activity.record.scopeEpoch ||
            saved.occurredAt.getTime() !==
              activity.record.occurredAt.getTime() ||
            !isDeepStrictEqual(immutable(previous), immutable(data))
          )
            throw new Error("Member activity immutable identity conflict");
          if (data.attribution.revision < previous.attribution.revision)
            return {
              status: "obsolete" as const,
              revision: previous.attribution.revision,
            };
          if (data.attribution.revision === previous.attribution.revision) {
            if (
              !isDeepStrictEqual(previous, data) ||
              saved.summary !== activity.record.summary ||
              saved.certainty !== activity.record.certainty ||
              !isDeepStrictEqual(saved.evidence, activity.record.evidence)
            )
              throw new Error("Member activity revision content conflict");
            return {
              status: "saved" as const,
              revision: data.attribution.revision,
            };
          }
          if (
            data.attribution.correctionCount <
            previous.attribution.correctionCount
          )
            throw new Error("Member activity correction count decreased");
        }
        // The activity owner checks live member/reference eligibility here,
        // under the same lock used to revoke matching before member mutations.
        assertCurrent();
        if (!saved) await tx.insert(contextRecords).values(activity.record);
        else
          await tx
            .update(contextRecords)
            .set({
              data,
              summary: activity.record.summary,
              certainty: activity.record.certainty,
              evidence: activity.record.evidence,
            })
            .where(eq(contextRecords.id, activity.record.id));
        await tx
          .delete(contextEntities)
          .where(
            and(
              eq(contextEntities.contextId, activity.record.id),
              eq(contextEntities.role, "subject"),
            ),
          );
        await tx
          .insert(contextEntities)
          .values([
            ...(current.kind === "known"
              ? [
                  {
                    contextId: activity.record.id,
                    entityType: current.association.memberKind,
                    entityId: current.association.memberId,
                    role: "subject" as const,
                  },
                ]
              : []),
            {
              contextId: activity.record.id,
              entityType: "device" as const,
              entityId: data.deviceId,
              role: "source" as const,
            },
          ])
          .onConflictDoNothing();
        assertCurrent();
        return {
          status: "saved" as const,
          revision: data.attribution.revision,
        };
      });
    },
  };
}
