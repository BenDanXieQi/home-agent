import { eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { memberSaveSchema } from "@home-agent/api/household-members";
import type { Database } from "../../db";
import {
  StorageOutcomeUnknownError,
  type Transaction,
} from "../../db/transaction-outcome";
import { householdSubjects, identityMembers } from "../../db/schema";
import { createHouseholdBindingAccess } from "../binding-repository";
import { HouseholdError } from "../errors";

import { createMemberWriter } from "../identity/repository";
import { identityClassForSubject } from "../identity/subject";

async function readMembers(tx: Transaction) {
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
        typeof row.details.species === "string" ? row.details.species : "",
      description:
        typeof row.details.description === "string"
          ? row.details.description
          : "",
    })),
  };
}

export function createMemberRepository(
  db: Database,
  cleanupReferences: () => Promise<void>,
  invalidateReferences: () => void,
) {
  const access = createHouseholdBindingAccess(db);
  const write = createMemberWriter(db);
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.error("Member repository subscriber failed", error);
      }
    }
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => write.close(),
    async access(
      identity: Parameters<typeof access>[0],
      assertCurrent: () => void,
      command?:
        | ReturnType<typeof memberSaveSchema.parse>
        | { id: string; operation: "delete" },
    ) {
      if (!command) return access(identity, assertCurrent, readMembers);
      let changed = false;
      let cleanupStarted = false;
      let expected:
        | Pick<
            typeof householdSubjects.$inferSelect,
            "name" | "kind" | "details"
          >
        | undefined;
      try {
        return await write(
          identity,
          assertCurrent,
          async (tx, beforeWrite) => {
            const [existing] = await tx
              .select()
              .from(householdSubjects)
              .where(eq(householdSubjects.id, command.id));
            if (command.operation === "delete") {
              if (existing) {
                beforeWrite();
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
                expected = values;
                beforeWrite();
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
                  expected = values;
                  beforeWrite();
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
            return readMembers(tx);
          },
          async (tx) => {
            const [stored] = await tx
              .select({
                name: householdSubjects.name,
                kind: householdSubjects.kind,
                details: householdSubjects.details,
              })
              .from(householdSubjects)
              .where(eq(householdSubjects.id, command.id));
            return isDeepStrictEqual(stored, expected)
              ? { committed: true, value: await readMembers(tx) }
              : { committed: false };
          },
          async (result) => {
            if (result.committed) notify();
            cleanupStarted = true;
            await cleanupReferences();
          },
        );
      } catch (error) {
        if (
          changed &&
          !cleanupStarted &&
          !(error instanceof StorageOutcomeUnknownError)
        )
          await cleanupReferences();
        throw error;
      }
    },
  };
}
