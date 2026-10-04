import { eq, sql } from "drizzle-orm";
import type { memberSaveSchema } from "@home-agent/api/household-members";
import type { Database } from "../../db";
import { householdSubjects } from "../../db/schema";
import { createHouseholdBindingAccess } from "../binding-repository";
import { HouseholdError } from "../errors";

export function createMemberRepository(db: Database) {
  const access = createHouseholdBindingAccess(db);
  return {
    async access(
      identity: Parameters<typeof access>[0],
      assertCurrent: () => void,
      command?:
        | ReturnType<typeof memberSaveSchema.parse>
        | { id: string; operation: "delete" },
    ) {
      return access(identity, assertCurrent, async (tx) => {
        if (command) {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended('household_members', 0))`,
          );
          const [existing] = await tx
            .select()
            .from(householdSubjects)
            .where(eq(householdSubjects.id, command.id));
          if (command.operation === "delete") {
            await tx
              .delete(householdSubjects)
              .where(eq(householdSubjects.id, command.id));
          } else {
            const profile = command.profile;
            const values = {
              name: profile.name,
              kind: profile.kind,
              details: {
                ...existing?.details,
                description: profile.description,
                ...(profile.kind === "pet" ? { species: profile.species } : {}),
              },
            };
            if (command.operation === "create") {
              if (existing) throw new HouseholdError("invalid_state");
              if ((await tx.$count(householdSubjects)) >= 500)
                throw new HouseholdError("capacity_exceeded");
              await tx
                .insert(householdSubjects)
                .values({ id: command.id, ...values });
            } else {
              if (!existing || existing.kind !== profile.kind)
                throw new HouseholdError("invalid_state");
              await tx
                .update(householdSubjects)
                .set(values)
                .where(eq(householdSubjects.id, command.id));
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
    },
  };
}
