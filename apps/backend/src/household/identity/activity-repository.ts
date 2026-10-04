import { and, eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { Database } from "../../db";
import {
  contextEntities,
  contextRecords,
  householdSubjects,
  identityMembers,
} from "../../db/schema";
import { createHouseholdBindingAccess } from "../binding-repository";
import { lockIdentityMembers, readReferenceVersion } from "./repository";
import { identityMatchingParameters } from "./matching-parameters";
import type { memberActivity } from "./activity";

export function createMemberActivityRepository(db: Database) {
  const access = createHouseholdBindingAccess(db);
  return {
    async save(
      identity: Parameters<typeof access>[0],
      assertCurrent: () => void,
      activity: NonNullable<ReturnType<typeof memberActivity>>,
    ) {
      return access(identity, assertCurrent, async (tx) => {
        await lockIdentityMembers(tx);
        const [member] = await tx
          .select({ id: householdSubjects.id })
          .from(householdSubjects)
          .where(
            and(
              eq(householdSubjects.id, activity.memberId),
              eq(householdSubjects.kind, activity.memberKind),
            ),
          );
        if (!member) return false;
        const [eligibility] = await tx
          .select()
          .from(identityMembers)
          .where(eq(identityMembers.memberId, activity.memberId));
        const version = await readReferenceVersion(tx);
        const expected = activity.record.data.referenceVersions;
        if (
          !eligibility?.enabled ||
          !isDeepStrictEqual(expected, {
            contentVersion: version.contentVersion,
            eligibilityVersion: version.eligibilityVersion,
            matchingVersion: identityMatchingParameters.matchingVersion,
            modelVersion: version.modelVersion,
            processingVersion: version.processingVersion,
          })
        )
          return false;
        await tx
          .insert(contextRecords)
          .values(activity.record)
          .onConflictDoUpdate({
            target: contextRecords.id,
            set: activity.record,
          });
        await tx
          .insert(contextEntities)
          .values([
            {
              contextId: activity.record.id,
              entityType: activity.memberKind,
              entityId: activity.memberId,
              role: "subject",
            },
            {
              contextId: activity.record.id,
              entityType: "device",
              entityId: activity.record.data.deviceId,
              role: "source",
            },
          ])
          .onConflictDoNothing();
        return true;
      });
    },
  };
}
