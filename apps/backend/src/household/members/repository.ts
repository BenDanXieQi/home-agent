import { eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { memberSaveSchema } from "@home-agent/api/household-members";
import type { Database } from "../../db";
import { householdSubjects, identityMembers } from "../../db/schema";
import { createHouseholdBindingAccess } from "../binding-repository";
import { HouseholdError } from "../errors";

import { lockIdentityMembers } from "../identity/repository";
import { identityClassForSubject } from "../identity/subject";

export function createMemberRepository(
  db: Database,
  cleanupReferences: () => Promise<void>,
  invalidateReferences: () => void,
) {
  const access = createHouseholdBindingAccess(db);
  return {
    async access(
      identity: Parameters<typeof access>[0],
      assertCurrent: () => void,
      command?:
        | ReturnType<typeof memberSaveSchema.parse>
        | { id: string; operation: "delete" },
    ) {
      let changed = false;
      try {
        return await access(identity, assertCurrent, async (tx) => {
          if (command) {
            await lockIdentityMembers(tx);
            const [existing] = await tx
              .select()
              .from(householdSubjects)
              .where(eq(householdSubjects.id, command.id));
            if (command.operation === "delete") {
              if (existing) {
                changed = true;
                const [referenceMember] = await tx
                  .select({ id: identityMembers.memberId })
                  .from(identityMembers)
                  .where(eq(identityMembers.memberId, command.id));
                const className = identityClassForSubject(
                  existing.kind,
                  existing.details.species,
                );
                if (
                  referenceMember ||
                  className === "cat" ||
                  className === "dog"
                )
                  invalidateReferences();
                await tx
                  .delete(householdSubjects)
                  .where(eq(householdSubjects.id, command.id));
              }
            } else {
              const profile = command.profile;
              const values = {
                name: profile.name,
                kind: profile.kind,
                details: {
                  ...existing?.details,
                  description: profile.description,
                  ...(profile.kind === "pet"
                    ? { species: profile.species }
                    : {}),
                },
              };
              if (command.operation === "create") {
                if (existing) throw new HouseholdError("invalid_state");
                if ((await tx.$count(householdSubjects)) >= 500)
                  throw new HouseholdError("capacity_exceeded");
                changed = true;
                const className = identityClassForSubject(
                  profile.kind,
                  profile.kind === "pet" ? profile.species : undefined,
                );
                if (className === "cat" || className === "dog") {
                  invalidateReferences();
                }
                await tx
                  .insert(householdSubjects)
                  .values({ id: command.id, ...values });
              } else {
                if (!existing || existing.kind !== profile.kind)
                  throw new HouseholdError("invalid_state");
                if (
                  !isDeepStrictEqual(values, {
                    name: existing.name,
                    kind: existing.kind,
                    details: existing.details,
                  })
                ) {
                  changed = true;
                  if (
                    profile.kind === "pet" &&
                    identityClassForSubject(
                      existing.kind,
                      existing.details.species,
                    ) !== identityClassForSubject(profile.kind, profile.species)
                  ) {
                    invalidateReferences();
                  }
                  await tx
                    .update(householdSubjects)
                    .set(values)
                    .where(eq(householdSubjects.id, command.id));
                }
              }
            }
          }
          const rows = await tx
            .select()
            .from(householdSubjects)
            .orderBy(householdSubjects.createdAt, householdSubjects.id);
          return {
            members: rows.map((row) => ({
              id: row.id,
              kind: row.kind,
              name: row.name,
              species:
                typeof row.details.species === "string"
                  ? row.details.species
                  : "",
              description:
                typeof row.details.description === "string"
                  ? row.details.description
                  : "",
            })),
          };
        });
      } finally {
        if (changed) await cleanupReferences();
      }
    },
  };
}
